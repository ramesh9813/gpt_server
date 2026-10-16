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

// OpenAI input_audio → Gemini inline audio bytes (mime from the format;
// the model itself rejects what it can't play, with its exact reason).
const inputAudioToInline = (input: { data?: unknown; format?: unknown }): GeminiPart | null => {
  if (typeof input?.data !== "string" || !input.data) return null;
  const fmt = typeof input.format === "string" ? input.format.toLowerCase() : "";
  const mime = fmt === "mp3" ? "audio/mp3" : fmt === "wav" ? "audio/wav" : fmt ? `audio/${fmt}` : "audio/mp3";
  return { inline_data: { mime_type: mime, data: input.data } };
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
        } else if (p.type === "input_audio") {
          const inline = inputAudioToInline(p.input_audio);
          if (inline) parts.push(inline);
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
          // Claude takes no audio: dropped here, but audio turns fail fast
          // with the exact reason before any request is built (see byok.ts).
          if (p.type !== "image_url") return null;
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

// Native audio payload present (input_audio parts). Text-only models reject
// the whole array content — those turns fail fast with the exact reason
// instead of answering blind.
export const hasAudioContent = (
  messages: OpenRouterMessage[]
): boolean =>
  messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: unknown }>).some((p) => p?.type === "input_audio")
  );

// Matches provider rejections of the output ceiling itself (small-context
// models, strict gateways): 400s about max_tokens / context limits. Those
// turns retry once WITHOUT any ceiling instead of failing.
export const isTokenLimitRejection = (status: number, errorText: string): boolean => {
  if (status !== 400 && status !== 422 && status !== 413) return false;
  return /max_tokens|maximum context|context length|too many tokens|token limit|exceeds.*limit|model.*maximum|context.*(full|exceeded)|unsupported.*parameter/i.test(
    errorText.slice(0, 1000)
  );
};

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
    const images = (m.content as unknown[]).filter(
      (p) => (p as { type?: unknown })?.type === "image_url"
    ).length;
    const audios = (m.content as unknown[]).filter(
      (p) => (p as { type?: unknown })?.type === "input_audio"
    ).length;
    const text = texts.join("\n").trim() || "Describe the attached image(s) in detail.";
    const notes: string[] = [];
    if (images > 0) notes.push(`[attached image${images > 1 ? "s" : ""} omitted — this model accepts text only]`);
    if (audios > 0) notes.push(`[attached audio omitted — this model accepts text only]`);
    return {
      ...m,
      content: notes.length > 0 ? `${text}\n${notes.join("\n")}` : text,
    };
  });

// ---- request building (pure, unit-tested per provider) -----------------------

export const buildByokStreamRequest = (
  byok: ByokRequest,
  messages: OpenRouterMessage[],
  opts: { think?: boolean; artifact?: boolean; webSearch?: boolean; noCeiling?: boolean; searchDepth?: number; research?: boolean } = {}
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } => {
  const { provider, model, apiKey } = byok;
  const allowReasoning = opts.think === true;
  const isArtifactTurn = opts.artifact === true;
  const isResearchTurn = opts.research === true;

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
        // artifact turns need room for the full HTML document; deep-research
        // reports run 2000-3000 words plus reasoning trace.
        max_tokens: isArtifactTurn
          ? TOKEN.ARTIFACT_MAX_TOKENS
          : isResearchTurn
            ? 16000
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
        ...(allowReasoning || isArtifactTurn || isResearchTurn
          ? {
              generationConfig: {
                ...(allowReasoning
                  ? { thinkingConfig: { includeThoughts: true } }
                  : {}),
                // Gemini caps output lower — artifact/research share its own ceiling.
                ...(isArtifactTurn || isResearchTurn
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
    ...(isArtifactTurn && opts.noCeiling !== true ? { max_tokens: TOKEN.ARTIFACT_MAX_TOKENS } : {}),
    // Research reports run long on any model — same document-grade ceiling.
    ...(isResearchTurn && !isArtifactTurn && opts.noCeiling !== true ? { max_tokens: 16000 } : {}),
    // Every OpenAI-compatible turn carries an explicit output budget:
    // providers apply their own (sometimes tiny) default when max_tokens is
    // omitted and cut answers mid-sentence. noCeiling is the escape hatch
    // for the token-limit retry (small-context/strict models).
    ...(!isArtifactTurn && !isResearchTurn && opts.noCeiling !== true
      ? { max_tokens: allowReasoning ? TOKEN.BYOK_REASONING_MAX_TOKENS : TOKEN.BYOK_DEFAULT_MAX_TOKENS }
      : {}),
    // Web search via an OpenRouter BYOK key uses the same native tool as the
    // built-in path — max_results follows the user's dynamic depth (5 when
    // the caller didn't resolve one; this builder stays DB-free for tests).
    ...(opts.webSearch === true && provider.id === "openrouter"
      ? {
          tools: [{ type: "openrouter:web_search", parameters: { engine: "auto", max_results: opts.searchDepth ?? 5 } }],
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
