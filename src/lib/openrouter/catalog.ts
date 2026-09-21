import { env } from "../config";
import { isDeprecatedModel } from "../modelThroughput";

type OpenRouterPricing = {
  prompt?: string;
  completion?: string;
};

export type CatalogSource = "authed" | "fallback";

export type CatalogMeta = {
  source: CatalogSource;
  fetchedAt: string;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  expiration_date?: string | null;
  is_deprecated?: boolean;
  status?: string;
  speed_rank?: number;
  pricing?: OpenRouterPricing;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
};

const CACHE_TTL_MS = 5 * 60 * 1000;
export let cachedModels: OpenRouterModel[] = [];
let cachedAt = 0;

const buildHeaders = (useAuth: boolean) => {
  const headers: Record<string, string> = {
    "HTTP-Referer": env.APP_ORIGIN,
    "X-Title": "ChatUI"
  };

  if (useAuth && env.OPENROUTER_API_KEY) {
    headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`;
  }

  return headers;
};

// Freshness tracking for the catalog endpoint. Kept separate from the array
// return so existing callers that expect OpenRouterModel[] keep working unchanged.
let lastSource: CatalogSource = "authed";
let lastFetchedAt = "";

export const getCatalogMeta = (): CatalogMeta => ({
  source: lastSource,
  fetchedAt: lastFetchedAt,
});

export const listOpenRouterModels = async (force?: boolean) => {
  const now = Date.now();
  if (!force && cachedModels.length > 0 && now - cachedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  let response = await fetch(
    `${env.OPENROUTER_BASE_URL}/models?output_modalities=text,image,video,audio&sort=throughput-high-to-low`,
    {
      headers: buildHeaders(true)
    }
  );
  let source: CatalogSource = "authed";
  if (response.status === 401 || response.status === 403) {
    response = await fetch(
      `${env.OPENROUTER_BASE_URL}/models?output_modalities=text,image,video,audio&sort=throughput-high-to-low`,
      {
        headers: buildHeaders(false)
      }
    );
    source = "fallback";
  }

  // Fallback to unparameterized models endpoint if sort param is not supported by proxy
  if (!response.ok) {
    response = await fetch(
      `${env.OPENROUTER_BASE_URL}/models?output_modalities=text,image,video,audio`,
      {
        headers: buildHeaders(false)
      }
    );
  }

  if (!response.ok) {
    response = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
      headers: buildHeaders(false)
    });
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  const models = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.data?.models)
    ? payload.data.models
    : [];

  cachedModels = models
    .filter(
      (model: unknown): model is OpenRouterModel =>
        !!model &&
        typeof model === "object" &&
        typeof (model as OpenRouterModel).id === "string"
    )
    .filter((model: OpenRouterModel) => !isDeprecatedModel(model))
    .map((model: OpenRouterModel, index: number) => ({
      ...model,
      speed_rank: index,
    }));
  cachedAt = now;
  lastSource = source;
  lastFetchedAt = new Date(now).toISOString();

  return cachedModels;
};
