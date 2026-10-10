// Pure BYOK request shaping — isolated from prisma/express so unit tests can
// cover every provider without the app/DB import chain (or its slow boot).
import type { ByokRequest } from "../../lib/byokTypes";
import { BYOK_USER_AGENT, firewallChallengeMessage, isFirewallChallengeBody } from "../../lib/byok";
import { TOKEN } from "../../lib/constants";
import type { OpenRouterMessage } from "./chatMappers";

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
  // Firewall challenge page (HTML): the server never reached the API — say
  // so plainly instead of dumping markup or blaming the key.
  if (isFirewallChallengeBody(errorText)) {
    return `${providerName} error (${status}): ${firewallChallengeMessage(providerName)}`;
  }
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

// ---- vision fallback (pure, unit-tested) --------------------------------------

// Some OpenAI-compatible providers/models reject multimodal array content
// outright (e.g. Groq 400 "messages[15].content must be a string" on
// text-only models). Vision-capable models accept the parts untouched, so
// the first attempt always sends images normally — these helpers only shape
// the one text-only retry.
export const hasMultimodalContent = (
  messages: OpenRouterMessage[]
): boolean =>
  messages.some((m) => Array.isArray(m.content));

// Matches provider rejections of array content (Groq "content must be a
// string", generic invalid-content/image/vision/multimodal 400s).
export const isVisionRejection = (status: number, errorText: string): boolean => {
  if (status !== 400) return false;
  return /must be a string|invalid[^.]{0,60}content|content[^.]{0,60}invalid|image|vision|multimodal/i.test(
    errorText.slice(0, 1000)
  );
};

// Collapse array content to plain text: keep text parts, note dropped images.
export const stripImageParts = (
  messages: OpenRouterMessage[]
): OpenRouterMessage[] =>
  messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const texts = (m.content as Array<{ type: string; text?: string }>)
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => (p as { text: string }).text);
    const images = (m.content as unknown[]).length - texts.length;
    const text = texts.join("\n").trim() || "Describe the attached image(s) in detail.";
    return {
      ...m,
      content:
        images > 0
          ? `${text}\n[attached image${images > 1 ? "s" : ""} omitted — this model accepts text only]`
          : text,
    };
  });

// ---- request building (pure, unit-tested per provider) -----------------------

export const buildByokStreamRequest = (
  byok: ByokRequest,
  messages: OpenRouterMessage[],
  opts: { think?: boolean; artifact?: boolean; webSearch?: boolean } = {}
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } => {
  const { provider, model, apiKey } = byok;
  const allowReasoning = opts.think === true;
  const isArtifactTurn = opts.artifact === true;

  if (provider.kind === "anthropic") {
    const { system, messages: anthropicMessages } = toAnthropicPayload(messages);
    return {
      url: `${provider.baseUrl}/messages`,
      headers: {
        "User-Agent": BYOK_USER_AGENT,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model,
        // Thinking mode needs headroom above the reasoning budget;
        // artifact turns need room for the full HTML document.
        max_tokens: isArtifactTurn
          ? TOKEN.ARTIFACT_MAX_TOKENS
          : allowReasoning
            ? 8192
            : 4096,
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
        "User-Agent": BYOK_USER_AGENT,
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: {
        ...toGeminiPayload(messages),
        ...(allowReasoning || isArtifactTurn
          ? {
              generationConfig: {
                ...(allowReasoning
                  ? { thinkingConfig: { includeThoughts: true } }
                  : {}),
                // Gemini caps output lower — use its own artifact ceiling.
                ...(isArtifactTurn
                  ? { maxOutputTokens: TOKEN.ARTIFACT_MAX_TOKENS_GEMINI }
                  : {}),
              },
            }
          : {}),
      },
    };
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    // Artifact turns emit a full HTML document — provider defaults truncate
    // them mid-code, so set an explicit ceiling (other turns untouched).
    ...(isArtifactTurn ? { max_tokens: TOKEN.ARTIFACT_MAX_TOKENS } : {}),
    // Groq cuts responses short when max_tokens is omitted (provider-side
    // default ceiling), so always send an explicit budget: thinking turns
    // need headroom above the reasoning trace, plain turns get the default.
    // Other OpenAI-compatible providers default to their model max — left
    // untouched so strict gateways/small models never 400.
    ...(provider.id === "groq" && !isArtifactTurn
      ? { max_tokens: allowReasoning ? TOKEN.BYOK_REASONING_MAX_TOKENS : TOKEN.BYOK_DEFAULT_MAX_TOKENS }
      : {}),
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
      "User-Agent": BYOK_USER_AGENT,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(provider.chatHeaders ?? {}),
    },
    body,
  };
};
