// Pure BYOK request shaping — isolated from prisma/express so unit tests can
// cover every provider without the app/DB import chain (or its slow boot).
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

// ---- provider error text (pure, unit-tested) ----------------------------------

// Maps a provider HTTP status to the actionable cause. CodeCraft-style
// gateways use 402 for empty balance, 403 for a key that lacks the needed
// scope, 404 for an unknown model id. Raw detail is kept so nothing is
// ever swallowed.
export const byokErrorMessage = (
  providerName: string,
  status: number,
  errorText: string
): string => {
  const cause =
    status === 401
      ? "Invalid or revoked API key."
      : status === 402
        ? "Out of balance — top up the provider account."
        : status === 403
          ? "Key lacks permission for this call (check the key's scopes in the provider dashboard)."
          : status === 404
            ? "Unknown model or endpoint — refresh the provider's model list and reselect."
            : status === 422
              ? "Invalid request — unknown model or unsupported parameter (refresh the model list and retry)."
              : status === 429
                ? "Rate limited — wait a moment and retry."
                : null;
  // Providers answer inside the OpenAI error envelope — surface the human
  // message, never the raw JSON.
  let detail = errorText.slice(0, 500);
  try {
    const parsed = JSON.parse(errorText);
    const msg = (parsed as any)?.error?.message;
    if (typeof msg === "string" && msg.trim()) {
      detail = msg.slice(0, 500);
    }
  } catch {
    // not JSON — keep the raw text
  }
  return `${providerName} error (${status}):${cause ? ` ${cause}` : ""}${detail ? ` ${detail}` : ""}`;
};

// ---- request building (pure, unit-tested per provider) -----------------------

export const buildByokStreamRequest = (
  byok: ByokRequest,
  messages: OpenRouterMessage[],
  opts: { think?: boolean; webSearch?: boolean } = {}
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } => {
  const { provider, model, apiKey } = byok;
  const allowReasoning = opts.think === true;

  if (provider.kind === "anthropic") {
    const { system, messages: anthropicMessages } = toAnthropicPayload(messages);
    return {
      url: `${provider.baseUrl}/messages`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model,
        // Thinking mode needs headroom above the reasoning budget.
        max_tokens: allowReasoning ? 8192 : 4096,
        stream: true,
        ...(allowReasoning
          ? { thinking: { type: "enabled", budget_tokens: 2048 } }
          : {}),
        ...(system ? { system } : {}),
        messages: anthropicMessages,
      },
    };
  }

  if (provider.kind === "gemini") {
    return {
      url: `${provider.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: {
        ...toGeminiPayload(messages),
        ...(allowReasoning
          ? { generationConfig: { thinkingConfig: { includeThoughts: true } } }
          : {}),
      },
    };
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // Web search via an OpenRouter BYOK key uses the same native tool as the
    // built-in path.
    ...(opts.webSearch === true && provider.id === "openrouter"
      ? {
          tools: [{ type: "openrouter:web_search", parameters: { engine: "auto", max_results: 5 } }],
          tool_choice: "auto",
        }
      : {}),
  };
  // Usage chunk: only where the provider officially supports `stream_options`
  // (OpenAI/OpenRouter). Strict gateways 422 on unlisted fields, so never send
  // it elsewhere.
  if (provider.streamUsage === true) {
    body.stream_options = { include_usage: true };
  }
  return {
    url: `${provider.baseUrl}/chat/completions`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(provider.chatHeaders ?? {}),
    },
    body,
  };
};
