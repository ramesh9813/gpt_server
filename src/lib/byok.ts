// Bring-your-own-key (BYOK) provider registry.
//
// Users may paste their own provider API key in the client Settings page. The
// key lives ONLY in browser localStorage and arrives per chat request via the
// x-byok-* headers below. It is used in-memory for that single request and is
// NEVER persisted in the database or written to logs.
import type { Request } from "express";

export type ByokProviderId = "openai" | "google" | "grok" | "meta" | "nvidia";
export type ByokApiKind = "openai" | "gemini";

export type ByokProvider = {
  id: ByokProviderId;
  name: string;
  kind: ByokApiKind;
  baseUrl: string;
  // Instant client/server format check before any network call is attempted.
  keyPattern: RegExp;
  keyHint: string;
  // Curated fallback list. The /api/byok/validate endpoint replaces it with
  // the live provider catalog when the key verifies.
  models: string[];
};

export const BYOK_PROVIDERS: Record<ByokProviderId, ByokProvider> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyPattern: /^sk-[A-Za-z0-9_-]{20,}$/,
    keyHint: "sk-...",
    models: [
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
      "o4-mini",
      "o3-mini",
    ],
  },
  google: {
    id: "google",
    name: "Google Gemini",
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyPattern: /^AIza[A-Za-z0-9_-]{30,}$/,
    keyHint: "AIza...",
    models: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
    ],
  },
  grok: {
    id: "grok",
    name: "Grok (xAI)",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    keyPattern: /^xai-[A-Za-z0-9_-]{20,}$/,
    keyHint: "xai-...",
    models: ["grok-4", "grok-3", "grok-3-fast", "grok-3-mini", "grok-2-1212"],
  },
  meta: {
    id: "meta",
    name: "Meta Llama",
    kind: "openai",
    baseUrl: "https://api.llama.com/compat/v1",
    keyPattern: /^(LLM\|[A-Za-z0-9_|.-]{8,}|[A-Za-z0-9_-]{20,})$/,
    keyHint: "LLM|...",
    models: [
      "Llama-4-Maverick-17B-128E-Instruct-FP8",
      "Llama-4-Scout-17B-16E-Instruct-FP8",
      "Llama-3.3-70B-Instruct",
      "Llama-3.3-8B-Instruct",
    ],
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyPattern: /^nvapi-[A-Za-z0-9_-]{20,}$/,
    keyHint: "nvapi-...",
    models: [
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "deepseek-ai/deepseek-r1",
      "mistralai/mistral-large-2-instruct",
      "qwen/qwen3-235b-a22b",
    ],
  },
};

export const getByokProvider = (raw: unknown): ByokProvider | null => {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase() as ByokProviderId;
  return BYOK_PROVIDERS[id] ?? null;
};

export const isByokKeyFormatSupported = (
  provider: ByokProvider,
  apiKey: string
): boolean => provider.keyPattern.test(apiKey.trim());

export type ByokRequest = {
  provider: ByokProvider;
  model: string;
  apiKey: string;
};

// Returns null when no BYOK headers are present (the normal OpenRouter path),
// { error } when BYOK was attempted but invalid, or the parsed request.
export const parseByokHeaders = (
  req: Request
): ByokRequest | { error: string } | null => {
  const providerRaw = String(req.headers["x-byok-provider"] ?? "").trim();
  if (!providerRaw) return null;
  const provider = getByokProvider(providerRaw);
  if (!provider) return { error: `Unknown provider "${providerRaw}".` };
  const model = String(req.headers["x-byok-model"] ?? "").trim();
  if (!model || model.length > 200) {
    return { error: "A model must be selected for the custom provider." };
  }
  const apiKey = String(req.headers["x-byok-key"] ?? "").trim();
  if (!apiKey || apiKey.length > 600) {
    return { error: `A valid ${provider.name} API key is required.` };
  }
  return { provider, model, apiKey };
};

// GET the provider's model catalog using the user's key. Used by the validate
// endpoint so the client dropdown can show live, key-authorized models.
export const fetchByokModels = async (
  provider: ByokProvider,
  apiKey: string
): Promise<string[]> => {
  if (provider.kind === "gemini") {
    const response = await fetch(`${provider.baseUrl}/models?pageSize=200`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const err = new Error(`provider returned ${response.status}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }
    const json = (await response.json()) as any;
    const list: any[] = Array.isArray(json?.models) ? json.models : [];
    return list
      .filter(
        (m) =>
          typeof m?.name === "string" &&
          Array.isArray(m?.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name).replace(/^models\//, ""))
      .filter(Boolean)
      .slice(0, 300);
  }

  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const err = new Error(`provider returned ${response.status}`) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }
  const json = (await response.json()) as any;
  const list: any[] = Array.isArray(json?.data) ? json.data : [];
  let ids = list
    .map((m) => String(m?.id ?? ""))
    .filter(Boolean);
  // OpenAI's catalog is huge and includes audio/embed/moderation models — keep
  // the dropdown focused on chat-capable families.
  if (provider.id === "openai") {
    ids = ids.filter((id) =>
      /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|image|tts|embed|moderation|instruct)/i.test(id)
    );
  }
  return ids.slice(0, 300);
};
