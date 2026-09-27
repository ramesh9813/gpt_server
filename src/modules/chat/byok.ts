// BYOK streaming: relay a chat turn to the user's OWN provider key
// (OpenAI-compatible endpoints + Google Gemini) and forward tokens as the same
// SSE event contract the OpenRouter path emits (`token` / `done` / `error`).
// The key arrives via request headers and is never stored or logged.
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import type { ByokRequest } from "../../lib/byok";
import { generateByokFollowups } from "./followups";
import { buildByokStreamRequest, byokErrorMessage } from "./byokRequest";
import type { OpenRouterMessage } from "./chat.service";

// ---- entry point ------------------------------------------------------------

export const streamByokCompletion = async (
  req: Request,
  res: Response,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    messages: OpenRouterMessage[];
    byok: ByokRequest;
    think?: boolean;
    webSearch?: boolean;
  }
) => {
  const { assistantMessageId, conversationId, messages, byok, think, webSearch } = opts;
  const { provider, model, apiKey } = byok;
  const storedModel = `${provider.id}:${model}`;
  const startedAt = Date.now();
  // "Thinking" mode: only forward reasoning tokens when the user armed it.
  const allowReasoning = think === true;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
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
  // Web-search citations (OpenRouter url_citation annotations) + one-shot
  // notice when the user's provider can't run web search at all.
  const sourceMap = new Map<string, { title: string; url: string }>();
  const webSearchSupported = provider.id === "openrouter";
  if (webSearch === true && !webSearchSupported) {
    sendEvent("notice", {
      message:
        "Web search isn't available with your provider key — answering from general knowledge.",
    });
  }

  const persistProgress = async () => {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        reasoning: allowReasoning ? assistantReasoning || null : null,
      },
    });
  };

  const finishAborted = async () => {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        reasoning: allowReasoning ? assistantReasoning || null : null,
        status: "COMPLETE",
        model: storedModel,
        durationMs: Date.now() - startedAt,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return safeEnd();
  };

  const fail = async (status: number, errorText: string) => {
    const message = byokErrorMessage(provider.name, status, errorText);
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: message },
    });
    sendEvent("error", { code: "BYOK_ERROR", message });
    return safeEnd();
  };

  try {
    const streamReq = buildByokStreamRequest(byok, messages, { think, webSearch });
    const response = await fetch(streamReq.url, {
      method: "POST",
      headers: streamReq.headers,
      body: JSON.stringify(streamReq.body),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const errorText = response.body ? await response.text() : "no response body";
      return fail(response.status, errorText);
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
          if (provider.kind === "anthropic") {
            // Messages-API SSE: text lives in content_block_delta events; usage
            // arrives via message_start (input) and message_delta (output).
            // Thinking mode adds thinking_delta blocks we forward as
            // `reasoning` events (same contract as the OpenRouter path).
            const type = parsed?.type;
            if (
              type === "content_block_delta" &&
              parsed.delta?.type === "text_delta" &&
              typeof parsed.delta.text === "string" &&
              parsed.delta.text.length > 0
            ) {
              assistantContent += parsed.delta.text;
              sendEvent("token", { delta: parsed.delta.text });
            }
            if (
              allowReasoning &&
              type === "content_block_delta" &&
              parsed.delta?.type === "thinking_delta" &&
              typeof parsed.delta.thinking === "string" &&
              parsed.delta.thinking.length > 0
            ) {
              assistantReasoning += parsed.delta.thinking;
              sendEvent("reasoning", { delta: parsed.delta.thinking });
            }
            if (type === "message_start" && parsed.message?.usage) {
              usage = {
                prompt_tokens: parsed.message.usage.input_tokens,
              };
            }
            if (type === "message_delta" && parsed.usage) {
              const completion = parsed.usage.output_tokens ?? 0;
              usage = {
                ...(usage ?? {}),
                completion_tokens: completion,
                total_tokens: (usage?.prompt_tokens ?? 0) + completion,
              };
            }
          } else if (provider.kind === "gemini") {
            const parts = parsed?.candidates?.[0]?.content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part?.thought) {
                  // Thinking parts: forwarded as `reasoning` only in Think mode.
                  if (
                    allowReasoning &&
                    typeof part?.text === "string" &&
                    part.text.length > 0
                  ) {
                    assistantReasoning += part.text;
                    sendEvent("reasoning", { delta: part.text });
                  }
                  continue;
                }
                if (typeof part?.text === "string" && part.text.length > 0) {
                  assistantContent += part.text;
                  sendEvent("token", { delta: part.text });
                }
              }
            }
            const meta = parsed?.usageMetadata;
            if (meta) {
              usage = {
                prompt_tokens: meta.promptTokenCount,
                completion_tokens:
                  (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
                total_tokens: meta.totalTokenCount,
              };
            }
          } else {
            // OpenRouter web_search citations arrive as url_citation annotations.
            const anns = parsed.choices?.[0]?.delta?.annotations;
            if (Array.isArray(anns)) {
              for (const a of anns) {
                const c = a?.url_citation;
                if (c && typeof c.url === "string" && c.url) {
                  sourceMap.set(c.url, {
                    url: c.url,
                    title: typeof c.title === "string" && c.title ? c.title : c.url,
                  });
                }
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              assistantContent += delta;
              sendEvent("token", { delta });
            }
            // Thinking stream (DeepSeek reasoner, xAI grok reasoning models
            // etc. emit delta.reasoning / reasoning_content): forward only in
            // Think mode, same contract as the OpenRouter path.
            const reasoning =
              parsed.choices?.[0]?.delta?.reasoning ??
              parsed.choices?.[0]?.delta?.reasoning_content;
            if (allowReasoning && typeof reasoning === "string" && reasoning.length > 0) {
              assistantReasoning += reasoning;
              sendEvent("reasoning", { delta: reasoning });
            }
            if (parsed.usage) usage = parsed.usage;
          }
        } catch {
          // ignore malformed chunks
        }
      }
      const now = Date.now();
      if (
        assistantContent.length - lastPersistedLength >= 200 ||
        now - lastPersistedAt > 1000
      ) {
        lastPersistedLength = assistantContent.length;
        lastPersistedAt = now;
        await persistProgress();
      }
    }

    // SSE tail: a final data: line can arrive without a trailing newline
    // (legal TCP split) and would otherwise be dropped with the buffer.
    // OpenAI-shaped path only — anthropic/gemini keep their own parsing.
    if (provider.kind !== "anthropic" && provider.kind !== "gemini") {
      const tail = `${buffer}${decoder.decode()}`.trim();
      if (tail.startsWith("data:")) {
        const data = tail.replace(/^data:\s*/, "");
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const anns = parsed.choices?.[0]?.delta?.annotations;
            if (Array.isArray(anns)) {
              for (const a of anns) {
                const c = a?.url_citation;
                if (c && typeof c.url === "string" && c.url) {
                  sourceMap.set(c.url, {
                    url: c.url,
                    title: typeof c.title === "string" && c.title ? c.title : c.url,
                  });
                }
              }
            }
            const tailDelta = parsed.choices?.[0]?.delta?.content;
            if (typeof tailDelta === "string" && tailDelta.length > 0) {
              assistantContent += tailDelta;
              sendEvent("token", { delta: tailDelta });
            }
            const tailReasoning =
              parsed.choices?.[0]?.delta?.reasoning ??
              parsed.choices?.[0]?.delta?.reasoning_content;
            if (
              allowReasoning &&
              typeof tailReasoning === "string" &&
              tailReasoning.length > 0
            ) {
              assistantReasoning += tailReasoning;
              sendEvent("reasoning", { delta: tailReasoning });
            }
            if (parsed.usage) usage = parsed.usage;
          } catch {
            // ignore malformed tail
          }
        }
      }
    }

    // A 200 with zero deltas (filtered, mis-parsed, or empty turn) must not
    // persist as a silent empty COMPLETE bubble — fail with a reason.
    if (!assistantContent && !assistantReasoning && !usage) {
      return fail(502, "The provider returned an empty stream (no content).");
    }

    const sources = [...sourceMap.values()];
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        reasoning: allowReasoning ? assistantReasoning || null : null,
        status: "COMPLETE",
        model: storedModel,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokenCount: usage?.total_tokens,
        durationMs: Date.now() - startedAt,
        ...(sources.length > 0 ? { usedSearch: true, sources } : {}),
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    if (sources.length > 0) {
      sendEvent("sources", { messageId: assistantMessageId, sources });
    }
    sendEvent("done", {
      messageId: assistantMessageId,
      usage: usage || {},
      durationMs: Date.now() - startedAt,
    });
    // Best-effort follow-up questions, generated on the user's own provider
    // (same UX as the OpenRouter path; never fails the stream).
    try {
      const followups = await generateByokFollowups(byok, assistantContent);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { followups },
        });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("BYOK followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return finishAborted();
    }
    return fail(0, err?.message || "Stream error");
  }
};
