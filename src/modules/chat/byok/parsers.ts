import type { ByokApiKind } from "../../../lib/byokTypes";

type ParseResult = {
  content: string;
  reasoning: string;
  usage: any;
  sources: Array<{ url: string; title: string }>;
  // A provider-side failure delivered INSIDE an open (HTTP 200) stream.
  // CleanAPIs documents this explicitly: "If the upstream provider fails
  // after the stream opens, an error frame is emitted" —
  //   data: {"error":{"message":"Upstream provider unavailable",...}}
  // Anthropic does the same with `type: "error"` events. Without this check
  // the stream ends with zero deltas and the user only ever sees the
  // misleading "empty stream (no content)" error instead of the real cause.
  streamError: { message: string; status: number } | null;
};

const emptyResult = (): ParseResult => ({ content: "", reasoning: "", usage: null, sources: [], streamError: null });

// Provider error delivered as a stream frame (not an HTTP status).
// OpenAI envelope: {"error":{"message","code"}} — CleanAPIs puts a numeric
// code (e.g. 502) there. Anthropic: {"type":"error","error":{"message"}}.
// Gemini: {"error":{"message","code"}}.
export const extractStreamError = (parsed: any): { message: string; status: number } | null => {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed?.type === "error" && typeof parsed?.error?.message === "string" && parsed.error.message.trim()) {
    const code = Number((parsed.error as any)?.code);
    return { message: parsed.error.message.trim().slice(0, 500), status: Number.isFinite(code) && code >= 400 && code < 600 ? code : 502 };
  }
  const err = (parsed as any)?.error;
  if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim()) {
    const code = Number((err as any)?.code);
    return { message: err.message.trim().slice(0, 500), status: Number.isFinite(code) && code >= 400 && code < 600 ? code : 502 };
  }
  return null;
};

export const parseAnthropicDelta = (parsed: any, allowReasoning: boolean): ParseResult => {
  const out: ParseResult = emptyResult();
  const streamError = extractStreamError(parsed);
  if (streamError) { out.streamError = streamError; return out; };
  const type = parsed?.type;
  if (type === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string" && parsed.delta.text.length > 0) out.content = parsed.delta.text;
  if (allowReasoning && type === "content_block_delta" && parsed.delta?.type === "thinking_delta" && typeof parsed.delta.thinking === "string" && parsed.delta.thinking.length > 0) out.reasoning = parsed.delta.thinking;
  if (type === "message_start" && parsed.message?.usage) out.usage = { prompt_tokens: parsed.message.usage.input_tokens };
  if (type === "message_delta" && parsed.usage) out.usage = { completion_tokens: parsed.usage.output_tokens ?? 0 };
  return out;
};

export const parseGeminiDelta = (parsed: any, allowReasoning: boolean): ParseResult => {
  const out: ParseResult = emptyResult();
  const streamError = extractStreamError(parsed);
  if (streamError) { out.streamError = streamError; return out; };
  const parts = parsed?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.thought) {
        if (allowReasoning && typeof part?.text === "string" && part.text.length > 0) out.reasoning += part.text;
        continue;
      }
      if (typeof part?.text === "string" && part.text.length > 0) out.content += part.text;
    }
  }
  const meta = parsed?.usageMetadata;
  if (meta) out.usage = { prompt_tokens: meta.promptTokenCount, completion_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0), total_tokens: meta.totalTokenCount };
  return out;
};

export const parseOpenAICompatibleDelta = (parsed: any, allowReasoning: boolean): ParseResult => {
  const out: ParseResult = emptyResult();
  const streamError = extractStreamError(parsed);
  if (streamError) { out.streamError = streamError; return out; };
  const anns = parsed.choices?.[0]?.delta?.annotations;
  if (Array.isArray(anns)) for (const a of anns) {
    const c = a?.url_citation;
    if (c && typeof c.url === "string" && c.url) out.sources.push({ url: c.url, title: typeof c.title === "string" && c.title ? c.title : c.url });
  }
  const delta = parsed.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta.length > 0) out.content = delta;
  const reasoning = parsed.choices?.[0]?.delta?.reasoning ?? parsed.choices?.[0]?.delta?.reasoning_content;
  if (allowReasoning && typeof reasoning === "string" && reasoning.length > 0) out.reasoning = reasoning;
  if (parsed.usage) out.usage = parsed.usage;
  return out;
};

export const parseByokDelta = (parsed: any, kind: ByokApiKind, allowReasoning: boolean): ParseResult => {
  if (kind === "anthropic") return parseAnthropicDelta(parsed, allowReasoning);
  if (kind === "gemini") return parseGeminiDelta(parsed, allowReasoning);
  return parseOpenAICompatibleDelta(parsed, allowReasoning);
};

// Fallback for providers that ignore `"stream": true` and answer with one
// regular (non-SSE) JSON completion object despite the 200 stream request.
// Without this the turn ends with zero deltas and fails as "empty stream"
// even though the provider DID answer. Accepts the OpenAI completion shape
// (choices[].message.content / reasoning_content / reasoning / usage),
// Anthropic message blocks, and Gemini candidates.
export const extractNonStreamingContent = (
  payloads: any[]
): { content: string; reasoning: string; usage: any } | null => {
  let content = "";
  let reasoning = "";
  let usage: any = null;
  for (const p of payloads) {
    if (!p || typeof p !== "object" || (p as any).error) continue;
    const choices = (p as any)?.choices;
    if (Array.isArray(choices)) {
      for (const c of choices) {
        const msg = (c as any)?.message ?? {};
        if (typeof msg.content === "string" && msg.content) content += msg.content;
        else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (typeof part?.text === "string" && part.text) content += part.text;
          }
        }
        for (const key of ["reasoning_content", "reasoning", "thinking"] as const) {
          const r = (msg as any)?.[key] ?? (c as any)?.[key];
          if (typeof r === "string" && r) reasoning += r;
        }
      }
    }
    const blocks = (p as any)?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if ((b?.type === "text" || b?.type === "thinking") && typeof b?.text === "string" && b.text) {
          if (b.type === "thinking") reasoning += b.text;
          else content += b.text;
        }
      }
    }
    const parts = (p as any)?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text) {
          if (part?.thought) reasoning += part.text;
          else content += part.text;
        }
      }
    }
    if ((p as any)?.usage && !usage) usage = (p as any).usage;
    const meta = (p as any)?.usageMetadata;
    if (meta && !usage) {
      usage = {
        prompt_tokens: meta.promptTokenCount,
        completion_tokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
        total_tokens: meta.totalTokenCount,
      };
    }
  }
  if (!content && !reasoning && !usage) return null;
  return { content, reasoning, usage };
};
