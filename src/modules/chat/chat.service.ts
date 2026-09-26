import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { generateFollowups } from "./followups";
import {
  getAvailableTools,
  executeMcpTool,
  type LlmToolDef,
} from "../llm/toolBridge";

// Vision: inline base64 dataURLs, no storage/S3. Keep small to fit 10mb JSON body.
export const MAX_IMAGES = 3;
export const MAX_IMAGE_STRING_LENGTH = 7 * 1024 * 1024; // ~7MB string each (~5MB binary + base64 overhead)
const IMAGE_PREFIX_REGEX = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/;

const imageDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_STRING_LENGTH, "Each image must be under ~7MB")
  .refine((v) => IMAGE_PREFIX_REGEX.test(v.slice(0, 50)), {
    message: "images must be dataURL jpeg/png/webp/gif base64",
  })
  .refine((v) => v.length > 30, {
    message: "images must contain base64 payload",
  });

export const streamSchema = z
  .object({
    conversationId: z.string(),
    userMessage: z.string().min(1).max(8000).optional(),
    existingUserMessageId: z.string().optional(),
    images: z.array(imageDataUrlSchema).max(MAX_IMAGES).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    research: z.boolean().optional(),
    artifact: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    think: z.boolean().optional(),
  })
  .refine((data) => data.userMessage || data.existingUserMessageId || (data.images && data.images.length > 0), {
    message: "userMessage or existingUserMessageId or images is required",
  })
  .refine((data) => !(data.userMessage && data.existingUserMessageId), {
    message: "Provide either userMessage or existingUserMessageId",
  });

export type StreamRequestBody = z.infer<typeof streamSchema>;

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };

export const mapRole = (role: string): OpenRouterMessage["role"] => {
  if (role === "SYSTEM") return "system";
  if (role === "ASSISTANT") return "assistant";
  return "user";
};

export const buildUserContent = (text: string, images?: string[]): OpenRouterContent => {
  if (!images || images.length === 0) return text;
  const safeText = text && text.trim().length > 0 ? text : "Describe the attached image(s) in detail.";
  return [{ type: "text", text: safeText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))];
};

export const getStoredImages = (msg: unknown): string[] => {
  const raw = (msg as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.startsWith("data:image/"));
};

// Avoid dumping multi-MB base64 into logs.
export const redactForLog = (messages: OpenRouterMessage[]) =>
  messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: (m.content as Array<OpenRouterTextPart | OpenRouterImagePart>).map((p) =>
        p.type === "image_url"
          ? { type: p.type, image_url: { url: `[omitted dataURL length=${p.image_url.url.length}]` } }
          : p
      ),
    };
  });


// Deep Research: dedicated research models (e.g. perplexity/sonar-deep-research,
// openai/o3-deep-research) search and synthesize autonomously. This prompt asks
// for a thorough, sourced report; max_tokens is raised since reports are long.
export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research analyst. Investigate the user's topic thoroughly using every source available to you. " +
  "Produce a comprehensive, well-structured report with clear headings, key findings up front, detailed analysis, " +
  "and a Sources section listing the URLs you relied on. Be factual, cite claims to sources, and note uncertainty " +
  "where sources disagree.";

// Web search (OpenRouter server tool): the model searches live website
// content and cites sources with markdown links. Opt-in per turn via
// `webSearch`; website search ONLY — never a reasoning/research process.
// Skipped when deep-research mode is on (those models search autonomously
// and may reject extra tools).
export const WEB_SEARCH_SYSTEM_PROMPT =
  "You have live web search. Synthesize answers from search results and cite sources with markdown links.";

export const streamOpenRouterCompletion = async (
  req: Request,
  res: Response,
  opts: { assistantMessageId: string; conversationId: string; messages: OpenRouterMessage[]; selectedModel: string; research?: boolean; webSearch?: boolean; think?: boolean; canvaUserId?: string }
) => {
  const { assistantMessageId, conversationId, messages, selectedModel, research, webSearch, think, canvaUserId } = opts;
  const startedAt = Date.now();
  // Reasoning stream: forwarded for deep-research turns, and for explicit
  // "Thinking" mode turns (Think chip in the composer). Plain/web-search turns
  // still get plain answers even if the model emits thinking tokens.
  const allowReasoning = research === true || think === true;
  if (!env.OPENROUTER_API_KEY) {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: "OPENROUTER_API_KEY is not configured on the server." },
    });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ code: "CONFIG_ERROR", message: "OPENROUTER_API_KEY is not configured on the server. Please set it in your Render environment variables." })}\n\n`);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const safeEnd = () => {
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  let assistantContent = "";
  let assistantReasoning = "";
  let lastPersistedLength = 0;
  let lastPersistedAt = Date.now();
  // Web-search citations collected from the provider stream (url_citation
  // annotations), plus a user-facing notice when search couldn't run.
  const sourceMap = new Map<string, { title: string; url: string }>();
  let searchNotice: string | null = null;
  const collectAnnotations = (chunk: any) => {
    const anns = chunk?.choices?.[0]?.delta?.annotations;
    if (!Array.isArray(anns)) return;
    for (const a of anns) {
      const c = a?.url_citation;
      if (c && typeof c.url === "string" && c.url) {
        sourceMap.set(c.url, {
          url: c.url,
          title: typeof c.title === "string" && c.title ? c.title : c.url,
        });
      }
    }
  };
  // Connector tools (Canva, OpenAI function-calling schema). Best-effort:
  // [] when disconnected/unconfigured, so the streaming path below is
  // untouched for everyone else. Skipped for deep-research turns (those
  // models search autonomously and may reject extra tools) — same
  // rationale as the web-search tool skip.
  let canvaTools: LlmToolDef[] = [];
  if (canvaUserId && research !== true) {
    try {
      canvaTools = await getAvailableTools(canvaUserId);
    } catch {
      canvaTools = [];
    }
  }
  type PendingToolCall = { id: string; name: string; arguments: string };
  console.log("Sending messages to OpenRouter:", JSON.stringify(redactForLog(messages), null, 2));

  // One streamed completion turn. Appends text/reasoning into the shared
  // buffers (persisted + forwarded live) and collects tool_calls deltas.
  // terminal:true means an error was already sent — the caller must return.
  const runTurn = async (
    turnMessages: OpenRouterMessage[]
  ): Promise<{ usage: any; toolCalls: PendingToolCall[]; terminal: boolean }> => {
    const pending: PendingToolCall[] = [];
    const useWebTool = webSearch === true && research !== true;
    const webTools = useWebTool
      ? [
          {
            type: "openrouter:web_search",
            parameters: { engine: "auto", max_results: 5 },
          },
        ]
      : [];
    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: research
        ? [{ role: "system", content: RESEARCH_SYSTEM_PROMPT }, ...turnMessages]
        : useWebTool
          ? [{ role: "system", content: WEB_SEARCH_SYSTEM_PROMPT }, ...turnMessages]
          : turnMessages,
      ...(webTools.length > 0 || canvaTools.length > 0
        ? { tools: [...webTools, ...canvaTools], tool_choice: "auto" }
        : {}),
      stream: true,
    };
    if (research) {
      // Research reports are long; raise the ceiling when in research mode.
      requestBody.max_tokens = 8000;
    }
    if (research || think) {
      // Deep-research and "Thinking" mode runs stream thinking tokens before
      // the synthesis; request + forward them (no server timeout is imposed —
      // the stream stays open until the model finishes or the client drops).
      requestBody.include_reasoning = true;
    }
    let response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_ORIGIN,
        "X-Title": "ChatUI",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    // Web-search edge case: the selected model may reject tool calling
    // entirely. Retry once WITHOUT the web tool and tell the client to note
    // "search unavailable, answering from general knowledge".
    if (!response.ok && useWebTool) {
      console.error("OpenRouter web-search turn failed, retrying without tools:", response.status);
      searchNotice =
        "Web search isn't available for the selected model — answering from general knowledge.";
      const fallbackBody: Record<string, unknown> = {
        model: selectedModel,
        messages: [
          { role: "system", content: WEB_SEARCH_SYSTEM_PROMPT },
          ...turnMessages,
        ],
        stream: true,
        ...(canvaTools.length > 0 ? { tools: canvaTools, tool_choice: "auto" } : {}),
      };
      response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_ORIGIN,
          "X-Title": "ChatUI",
        },
        body: JSON.stringify(fallbackBody),
        signal: controller.signal,
      });
    }
    console.log("OpenRouter Response Status:", response.status, response.statusText);
    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error("OpenRouter Error:", errorText);
      await prisma.message.update({ where: { id: assistantMessageId }, data: { status: "ERROR", error: errorText } });
      sendEvent("error", { code: "OPENROUTER_ERROR", message: `OpenRouter error: ${errorText}` });
      safeEnd();
      return { usage: null, toolCalls: [], terminal: true };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let usage: any = null;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.replace(/^data:\s*/, "");
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(data);
          collectAnnotations(parsed);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            assistantContent += delta;
            sendEvent("token", { delta });
          }
          // Thinking stream: forwarded live for the reasoning accordion —
          // deep-research turns ONLY. Web-search/normal turns never show
          // a reasoning process, even if the model emits thinking tokens.
          const reasoning =
            parsed.choices?.[0]?.delta?.reasoning ??
            parsed.choices?.[0]?.delta?.reasoning_content;
          if (allowReasoning && typeof reasoning === "string" && reasoning.length > 0) {
            assistantReasoning += reasoning;
            sendEvent("reasoning", { delta: reasoning });
          }
          // Connector tool calls (Canva): accumulate index-keyed deltas so
          // the turn below can execute them and stream the final answer.
          const toolCallDeltas = parsed.choices?.[0]?.delta?.tool_calls;
          if (Array.isArray(toolCallDeltas)) {
            for (const tc of toolCallDeltas) {
              const idx = typeof tc?.index === "number" ? tc.index : 0;
              if (!pending[idx]) pending[idx] = { id: "", name: "", arguments: "" };
              if (typeof tc?.id === "string") pending[idx].id += tc.id;
              if (typeof tc?.function?.name === "string") pending[idx].name += tc.function.name;
              if (typeof tc?.function?.arguments === "string") {
                pending[idx].arguments += tc.function.arguments;
              }
            }
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // ignore malformed chunks
        }
      }
      const now = Date.now();
      if (
        assistantContent.length + assistantReasoning.length - lastPersistedLength >= 200 ||
        now - lastPersistedAt > 1000
      ) {
        lastPersistedLength = assistantContent.length + assistantReasoning.length;
        lastPersistedAt = now;
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { content: assistantContent, reasoning: allowReasoning ? assistantReasoning || null : null },
        });
      }
    }
    return { usage, toolCalls: pending, terminal: false };
  };

  try {
    let turnMessages = messages;
    let usage: any = null;
    // At most one tool round-trip: turn 0 may request connector calls, turn
    // 1 streams the final answer with their results in context. When no
    // tools are connected this loop runs exactly once, as before.
    for (let turn = 0; ; turn += 1) {
      const result = await runTurn(turnMessages);
      if (result.terminal) return;
      usage = result.usage ?? usage;
      const requested = result.toolCalls.filter((c) => c.name);
      if (canvaTools.length === 0 || requested.length === 0 || turn >= 1 || !canvaUserId) {
        break;
      }
      const uid = canvaUserId;
      // Live phase for the client status line; unknown to older clients,
      // which safely ignore unrecognized SSE event types.
      sendEvent("tools", { names: requested.map((c) => c.name) });
      const toolResults: Array<{ id: string; text: string }> = [];
      for (const tc of requested) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          const raw = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
          parsedArgs = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        } catch {
          toolResults.push({
            id: tc.id,
            text: "Error: the model produced invalid JSON arguments and they were rejected.",
          });
          continue;
        }
        try {
          toolResults.push({ id: tc.id, text: await executeMcpTool(uid, tc.name, parsedArgs) });
        } catch (err: any) {
          toolResults.push({ id: tc.id, text: `Error: ${err?.message || "tool execution failed"}` });
        }
      }
      if (controller.signal.aborted) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: {
            content: assistantContent,
            reasoning: allowReasoning ? assistantReasoning || null : null,
            status: "COMPLETE",
            model: selectedModel,
            durationMs: Date.now() - startedAt,
          },
        });
        await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        return safeEnd();
      }
      // The final answer streams fresh in the next turn.
      assistantContent = "";
      assistantReasoning = "";
      lastPersistedLength = 0;
      turnMessages = [
        ...turnMessages,
        {
          role: "assistant",
          content: "",
          tool_calls: requested.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        ...toolResults.map((r) => ({
          role: "tool",
          tool_call_id: r.id,
          content: r.text,
        })),
      ] as unknown as OpenRouterMessage[];
    }
    const sources = [...sourceMap.values()];
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        reasoning: allowReasoning ? assistantReasoning || null : null,
        status: "COMPLETE",
        model: selectedModel,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokenCount: usage?.total_tokens,
        durationMs: Date.now() - startedAt,
        ...(sources.length > 0
          ? { usedSearch: true, sources }
          : { usedSearch: false }),
      },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    if (sources.length > 0) {
      sendEvent("sources", { messageId: assistantMessageId, sources });
    }
    if (searchNotice) {
      // system_notice style event: render as a dismissible inline banner.
      sendEvent("notice", { message: searchNotice });
    }
    sendEvent("done", { messageId: assistantMessageId, usage: usage || {}, durationMs: Date.now() - startedAt });
    // Best-effort follow-up questions (never fails the stream).
    try {
      const followups = await generateFollowups(selectedModel, assistantContent);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { followups },
        });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("Followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      await prisma.message.update({
        where: { id: assistantMessageId },
        data: {
          content: assistantContent,
          reasoning: allowReasoning ? assistantReasoning || null : null,
          status: "COMPLETE",
          model: selectedModel,
          durationMs: Date.now() - startedAt,
        },
      });
      await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return safeEnd();
    }
    console.error("Stream error:", err);
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: err?.message || "Stream error" },
    });
    sendEvent("error", { code: "STREAM_ERROR", message: "Streaming failed" });
    return safeEnd();
  }
};

// Compat re-exports: chat.routes imports these from ./chat.service.
export { sseHead, sseSend, sseEnd, finishTextReply, sendSimpleTextFinish } from "./sse";
export { wantsImageGeneration, wantsVideo, wantsVideoGeneration, MAX_VIDEOS } from "./intents";
export { wantsMcq } from "./mcq";
export { generateFollowups } from "./followups";
export { sendMcqReply, mcqSchema, hashQuestion } from "./mcq";
export type { McqReplyOpts } from "./mcq";
export { sendImageReply, sendVideoReply } from "./mediaReply";
export { wantsArtifact, ARTIFACT_SYSTEM_PROMPT, ARTIFACT_INTENT } from "./artifact";
