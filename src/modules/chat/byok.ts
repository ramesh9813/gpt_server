// BYOK streaming: relay a chat turn to the user's OWN provider key
// (OpenAI-compatible endpoints + Google Gemini) and forward tokens as the same
// SSE event contract the OpenRouter path emits (`token` / `done` / `error`).
// The key arrives via request headers and is never stored or logged.
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import type { ByokRequest } from "../../lib/byok";
import { isFirewallChallengeBody } from "../../lib/byok";
import { logger } from "../../lib/logger";
import { generateByokFollowups, isFollowupsEnabled } from "./followups";
import { buildByokStreamRequest, byokErrorMessage, hasMultimodalContent, isVisionRejection, stripImageParts } from "./byokRequest";
import { extractNonStreamingContent, extractStreamError } from "./byok/parsers";
import type { OpenRouterMessage } from "./chat.service";
import { WEB_SEARCH_SYSTEM_PROMPT } from "./chat.service";
import { buildSearchContextBlock, performWebSearch, wantsWebSearch } from "../../lib/websearch";

// ---- entry point ------------------------------------------------------------

export const streamByokCompletion = async (
  req: Request,
  res: Response,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    messages: OpenRouterMessage[];
    byok: ByokRequest;
    userMessageId?: string;
    think?: boolean;
    artifact?: boolean;
    webSearch?: boolean;
  }
) => {
  const { assistantMessageId, conversationId, messages, byok, userMessageId, think, artifact, webSearch } = opts;
  const { provider, model, apiKey } = byok;
  const storedModel = `${provider.id}:${model}`;
  const startedAt = Date.now();
  // "Thinking" mode: only forward reasoning tokens when the user armed it.
  const allowReasoning = think === true;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
    Pragma: "no-cache",
  });
  try {
    (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  } catch {}
  try {
    (res.socket as unknown as { setNoDelay?: (v: boolean) => void })?.setNoDelay?.(true);
  } catch {}
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    try {
      (res as unknown as { flush?: () => void }).flush?.();
    } catch {}
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
  // Universal search: same server-side injection as the built-in path, so
  // EVERY provider (OpenAI-compat, Gemini, Anthropic, custom) gets live
  // results + bottom URL list. No native tool required. Runs on the toggle
  // OR automatically when the prompt carries a search/news/recency intent.
  let searchMessages = messages;
  const sourceMap = new Map<string, { title: string; url: string }>();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const rawQuery =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? (lastUser.content as any[]).filter((p) => p?.type === "text").map((p) => p.text).join("\n")
        : "";
  if (webSearch === true || wantsWebSearch(rawQuery)) {
    const query = rawQuery.replace(/\[.*?\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    if (query) {
      try {
        const hits = await performWebSearch(query, 5);
        for (const h of hits) {
          if (!sourceMap.has(h.url)) sourceMap.set(h.url, { url: h.url, title: h.title });
        }
        if (hits.length > 0) {
          const block = buildSearchContextBlock(query, hits);
          searchMessages = [
            { role: "system", content: `${WEB_SEARCH_SYSTEM_PROMPT}\n\n${block}` },
            ...messages,
          ];
        }
      } catch (err) {
        logger.warn({ err }, "Universal BYOK web search failed, continuing without results");
      }
    }
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
    const challenged = isFirewallChallengeBody(errorText);
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: message },
    });
    // Row ids ride along so the browser-direct fallback can resume this
    // exact turn (old clients ignore unknown fields).
    sendEvent("error", {
      code: "BYOK_ERROR",
      message,
      ...(challenged ? { challenged: true } : {}),
      assistantMessageId,
      ...(userMessageId ? { userMessageId } : {}),
    });
    return safeEnd();
  };

  try {
    const streamReq = buildByokStreamRequest(byok, searchMessages, { think, artifact, webSearch });
    // One request sender so a transient provider blip can be retried below.
    const doProviderFetch = (req = streamReq) => {
      // Combine client disconnect + hard timeout so a slow/malicious provider cannot hold the worker forever
      const byokTimeout = AbortSignal.timeout(90_000);
      const combinedSignal: AbortSignal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([controller.signal, byokTimeout])
          : controller.signal;
      // Fallback timer when AbortSignal.any is unavailable
      let timeoutSub: ReturnType<typeof setTimeout> | null = null;
      if (typeof (AbortSignal as unknown as { any?: unknown }).any !== "function") {
        timeoutSub = setTimeout(() => controller.abort(), 90_000);
      }
      return fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: combinedSignal,
      }).finally(() => {
        if (timeoutSub) clearTimeout(timeoutSub);
      });
    };
    // Transient provider hiccups (rate limit / overloaded / gateway errors)
    // are worth exactly one automatic retry — otherwise a mid-chat blip the
    // user did nothing to cause surfaces as "No response was generated".
    // Auth/balance/scope/model errors (401/402/403/404/422) fail immediately.
    const isRetryableProviderStatus = (status: number) =>
      status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    let response = await doProviderFetch();
    if (
      (!response.ok || !response.body) &&
      isRetryableProviderStatus(response.status) &&
      !controller.signal.aborted
    ) {
      logger.warn(
        { provider: provider.name, model, status: response.status },
        "BYOK transient provider error, retrying once"
      );
      try {
        await response.text();
      } catch {
        // best-effort drain only
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!controller.signal.aborted) response = await doProviderFetch();
    }
    // Vision fallback: OpenAI-compatible providers whose models reject
    // multimodal array content (e.g. Groq 400 "content must be a string")
    // get exactly one text-only retry so image sends still answer instead of
    // dying as "No response was generated". Vision-capable models never reach
    // here — the first attempt succeeds untouched.
    // consumedError carries an already-read body into the final fail below:
    // re-reading it would throw "Body has already been read" and mask the
    // real provider error as Groq error (0).
    let consumedError: string | null = null;
    if (
      !response.ok &&
      provider.kind === "openai" &&
      hasMultimodalContent(searchMessages) &&
      !controller.signal.aborted
    ) {
      let visionError = "";
      try {
        visionError = await response.text();
        consumedError = visionError;
      } catch {
        // best-effort drain only
      }
      if (isVisionRejection(response.status, visionError)) {
        logger.warn(
          { provider: provider.name, model, status: response.status },
          "BYOK provider rejects image content, retrying text-only once"
        );
        const textReq = buildByokStreamRequest(byok, stripImageParts(searchMessages), {
          think,
          artifact,
          webSearch,
        });
        if (!controller.signal.aborted) {
          response = await doProviderFetch(textReq);
          if (response.ok && response.body) {
            sendEvent("notice", {
              message:
                "This model can't view images — answered from your text only. Pick a vision-capable model to discuss the picture.",
            });
          }
        }
      }
    }

    if (!response.ok || !response.body) {
      const errorText =
        consumedError ?? (response.body ? await response.text() : "no response body");
      return fail(response.status, errorText);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let usage: any = null;
    // Every parsed frame + raw bytes: feeds the non-SSE fallback (gateways
    // that ignore "stream": true) and the empty-stream diagnostic log.
    const parsedPayloads: any[] = [];
    let rawText = "";

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      const text = decoder.decode(value, { stream: true });
      rawText += text;
      buffer += text;
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
          parsedPayloads.push(parsed);
          // The provider failed AFTER opening the stream (CleanAPIs documents
          // `data: {"error":{...}}` frames for this): surface its real message
          // instead of the misleading "empty stream" error below.
          const streamError = extractStreamError(parsed);
          if (streamError) {
            return fail(streamError.status, streamError.message);
          }
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
            parsedPayloads.push(parsed);
            const tailError = extractStreamError(parsed);
            if (tailError) {
              return fail(tailError.status, tailError.message);
            }
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

    // Some gateways ignore `"stream": true` and answer with one regular
    // (non-SSE) JSON completion object on a 200. Recover its text before
    // calling the turn empty — the provider DID answer.
    if (!assistantContent && !assistantReasoning) {
      const candidates = [...parsedPayloads];
      const whole = `${rawText}${buffer}${decoder.decode()}`.trim();
      if (whole && !whole.startsWith("data:") && !whole.startsWith(":")) {
        try {
          candidates.push(JSON.parse(whole));
        } catch {
          // not a single JSON body — fall through to the empty check
        }
      }
      const recovered = extractNonStreamingContent(candidates);
      if (recovered && (recovered.content || recovered.reasoning)) {
        if (recovered.content) {
          assistantContent = recovered.content;
          sendEvent("token", { delta: recovered.content });
        }
        if (recovered.reasoning && allowReasoning) {
          assistantReasoning = recovered.reasoning;
          sendEvent("reasoning", { delta: recovered.reasoning });
        }
        if (recovered.usage && !usage) usage = recovered.usage;
      }
    }

    // A 200 with zero deltas (filtered, mis-parsed, or empty turn) must not
    // persist as a silent empty COMPLETE bubble — fail with a reason.
    if (!assistantContent && !assistantReasoning && !usage) {
      logger.warn(
        { provider: provider.id, model, head: rawText.slice(0, 300) },
        "BYOK stream ended with no parseable content"
      );
      return fail(502, "The provider returned an empty stream (no content).");
    }

    const sources = [...sourceMap.values()];
    // Bottom links render from the persisted `sources` row (client plain
    // list) — no body footer, so URLs never appear twice.
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
    // (same UX as the OpenRouter path; never fails the stream). Skipped
    // entirely when the user turned follow-ups off in Settings.
    try {
      if (!(await isFollowupsEnabled((req as any).user?.id))) return safeEnd();
      const followups = await generateByokFollowups(byok, assistantContent);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { followups },
        });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      const { logger } = await import("../../lib/logger");
      logger.error({ err }, "BYOK followups error");
    }
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return finishAborted();
    }
    return fail(0, err?.message || "Stream error");
  }
};
