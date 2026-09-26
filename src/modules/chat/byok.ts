// BYOK streaming: relay a chat turn to the user's OWN provider key
// (OpenAI-compatible endpoints + Google Gemini) and forward tokens as the same
// SSE event contract the OpenRouter path emits (`token` / `done` / `error`).
// The key arrives via request headers and is never stored or logged.
import type { Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import type { ByokRequest } from "../../lib/byok";
import type { OpenRouterMessage } from "./chat.service";

// ---- Gemini request shaping -------------------------------------------------

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

const dataUrlToInline = (url: string): GeminiPart | null => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(url);
  if (!match) return null;
  return { inline_data: { mime_type: match[1], data: match[2] } };
};

const toGeminiPayload = (messages: OpenRouterMessage[]) => {
  const sysParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n");
      if (text.trim()) sysParts.push(text);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content || " " });
    } else {
      for (const p of m.content) {
        if (p.type === "text") {
          if (p.text.trim()) parts.push({ text: p.text });
        } else {
          const inline = dataUrlToInline(p.image_url.url);
          if (inline) parts.push(inline);
        }
      }
    }
    if (parts.length === 0) parts.push({ text: " " });
    contents.push({ role, parts });
  }
  return {
    ...(sysParts.length > 0
      ? { systemInstruction: { parts: [{ text: sysParts.join("\n\n") }] } }
      : {}),
    contents,
  };
};

// ---- Anthropic (Messages API) request shaping --------------------------------

type AnthropicPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

const toAnthropicPayload = (messages: OpenRouterMessage[]) => {
  const sysParts: string[] = [];
  const msgs: Array<{ role: "user" | "assistant"; content: AnthropicPart[] }> =
    [];
  for (const m of messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join("\n");
      if (text.trim()) sysParts.push(text);
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    let parts: AnthropicPart[];
    if (typeof m.content === "string") {
      parts = [{ type: "text", text: m.content.trim() ? m.content : " " }];
    } else {
      parts = m.content
        .map((p): AnthropicPart | null => {
          if (p.type === "text")
            return p.text.trim() ? { type: "text", text: p.text } : null;
          const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(
            p.image_url.url
          );
          return match
            ? {
                type: "image",
                source: { type: "base64", media_type: match[1], data: match[2] },
              }
            : null;
        })
        .filter((p): p is AnthropicPart => p !== null);
      if (parts.length === 0) parts = [{ type: "text", text: " " }];
    }
    // Anthropic requires strictly alternating user/assistant turns.
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) {
      last.content = [...last.content, ...parts];
    } else {
      msgs.push({ role, content: parts });
    }
  }
  return {
    ...(sysParts.length > 0 ? { system: sysParts.join("\n\n") } : {}),
    messages: msgs,
  };
};

// ---- entry point ------------------------------------------------------------

export const streamByokCompletion = async (
  req: Request,
  res: Response,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    messages: OpenRouterMessage[];
    byok: ByokRequest;
  }
) => {
  const { assistantMessageId, conversationId, messages, byok } = opts;
  const { provider, model, apiKey } = byok;
  const storedModel = `${provider.id}:${model}`;

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
  let lastPersistedLength = 0;
  let lastPersistedAt = Date.now();

  const persistProgress = async () => {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: assistantContent },
    });
  };

  const finishAborted = async () => {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: assistantContent, status: "COMPLETE", model: storedModel },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    return safeEnd();
  };

  const fail = async (status: number, errorText: string) => {
    const message = `${provider.name} error (${status}): ${errorText.slice(0, 500)}`;
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: message },
    });
    sendEvent("error", { code: "BYOK_ERROR", message });
    return safeEnd();
  };

  try {
    let response: globalThis.Response;
    if (provider.kind === "anthropic") {
      const { system, messages: anthropicMessages } =
        toAnthropicPayload(messages);
      response = await fetch(`${provider.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          stream: true,
          ...(system ? { system } : {}),
          messages: anthropicMessages,
        }),
        signal: controller.signal,
      });
    } else if (provider.kind === "gemini") {
      response = await fetch(
        `${provider.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(toGeminiPayload(messages)),
          signal: controller.signal,
        }
      );
    } else {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
      };
      // OpenAI-compatible usage chunk: supported by OpenAI/xAI/NVIDIA/
      // OpenRouter. Meta's compat layer is stricter, so only opt in where
      // documented.
      if (provider.id !== "meta") {
        body.stream_options = { include_usage: true };
      }
      response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(provider.chatHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }

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
                // Skip thinking-model "thought" parts; forward plain text.
                if (part?.thought) continue;
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
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              assistantContent += delta;
              sendEvent("token", { delta });
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

    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        status: "COMPLETE",
        model: storedModel,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokenCount: usage?.total_tokens,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
    sendEvent("done", { messageId: assistantMessageId, usage: usage || {} });
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      return finishAborted();
    }
    return fail(0, err?.message || "Stream error");
  }
};
