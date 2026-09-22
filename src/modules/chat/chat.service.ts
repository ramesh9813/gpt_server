import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { generateFollowups } from "./followups";

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
  opts: { assistantMessageId: string; conversationId: string; messages: OpenRouterMessage[]; selectedModel: string; research?: boolean; webSearch?: boolean }
) => {
  const { assistantMessageId, conversationId, messages, selectedModel, research, webSearch } = opts;
  // Strict mode split: ONLY a deep-research turn runs the reasoning +
  // research process. Web-search and normal turns get website/plain answers
  // with no thinking stream — even if the model emits reasoning tokens.
  const allowReasoning = research === true;
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
  console.log("Sending messages to OpenRouter:", JSON.stringify(redactForLog(messages), null, 2));
  try {
    const useWebTool = webSearch === true && research !== true;
    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: research
        ? [{ role: "system", content: RESEARCH_SYSTEM_PROMPT }, ...messages]
        : useWebTool
          ? [{ role: "system", content: WEB_SEARCH_SYSTEM_PROMPT }, ...messages]
          : messages,
      ...(useWebTool
        ? {
            tools: [
              {
                type: "openrouter:web_search",
                parameters: { engine: "auto", max_results: 5 },
              },
            ],
          }
        : {}),
      stream: true,
    };
    if (research) {
      // Research reports are long; raise the ceiling when in research mode.
      requestBody.max_tokens = 8000;
      // Deep-research runs stream thinking tokens for 30-120s+ before the
      // synthesis; request + forward them (no server timeout is imposed —
      // the stream stays open until the model finishes or the client drops).
      requestBody.include_reasoning = true;
    }
    const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
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
    console.log("OpenRouter Response Status:", response.status, response.statusText);
    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error("OpenRouter Error:", errorText);
      await prisma.message.update({ where: { id: assistantMessageId }, data: { status: "ERROR", error: errorText } });
      sendEvent("error", { code: "OPENROUTER_ERROR", message: `OpenRouter error: ${errorText}` });
      return safeEnd();
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
      },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    sendEvent("done", { messageId: assistantMessageId, usage: usage || {} });
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
