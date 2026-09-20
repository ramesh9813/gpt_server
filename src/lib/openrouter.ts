import { env } from "./config";
import { FREE_MODEL_ONLY_ROLE, UserRole } from "./userRoles";

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
  pricing?: OpenRouterPricing;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
};

export const isDeprecatedModel = (
  modelOrId?: OpenRouterModel | string | null
): boolean => {
  if (!modelOrId) return true;

  if (typeof modelOrId === "string") {
    const id = modelOrId.toLowerCase();
    return (
      id.endsWith(":online") ||
      id.endsWith(":thinking") ||
      id.endsWith(":extended") ||
      id.endsWith(":deprecated") ||
      id.includes("/deprecated") ||
      /\b(deprecated|discontinued|sunsetted|decommissioned)\b/i.test(id)
    );
  }

  // 1. OpenRouter expiration_date indicates scheduled/active deprecation
  if (
    typeof modelOrId.expiration_date === "string" &&
    modelOrId.expiration_date.trim().length > 0
  ) {
    return true;
  }

  // 2. Explicit deprecation or status flag
  if (modelOrId.is_deprecated === true || modelOrId.status === "deprecated") {
    return true;
  }

  const id = (modelOrId.id || "").toLowerCase();
  const name = (modelOrId.name || "").toLowerCase();
  const desc = (modelOrId.description || "").toLowerCase();

  // 3. Known deprecated OpenRouter model variants
  if (
    id.endsWith(":online") ||
    id.endsWith(":thinking") ||
    id.endsWith(":extended") ||
    id.endsWith(":deprecated") ||
    id.includes("/deprecated")
  ) {
    return true;
  }

  // 4. Deprecation keywords in model ID, display name, or description
  if (
    /\b(deprecated|discontinued|sunsetted|decommissioned)\b/i.test(name) ||
    /\b(deprecated|discontinued|sunsetted|decommissioned)\b/i.test(id) ||
    /\b(is deprecated|has been deprecated|model is deprecated|no longer supported)\b/i.test(desc)
  ) {
    return true;
  }

  return false;
};

export const supportsImageGeneration = (
  modelOrId: OpenRouterModel | string | undefined | null,
  catalog?: OpenRouterModel[]
): boolean => {
  const entry =
    typeof modelOrId === "string"
      ? (catalog ?? cachedModels).find((m) => m.id === modelOrId)
      : modelOrId;
  const out = entry?.architecture?.output_modalities;
  return Array.isArray(out) && out.includes("image");
};

export const supportsVideoGeneration = (
  modelOrId: OpenRouterModel | string | undefined | null,
  catalog?: OpenRouterModel[]
): boolean => {
  const entry =
    typeof modelOrId === "string"
      ? (catalog ?? cachedModels).find((m) => m.id === modelOrId)
      : modelOrId;
  const out = entry?.architecture?.output_modalities;
  return Array.isArray(out) && out.includes("video");
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedModels: OpenRouterModel[] = [];
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

const toNumber = (value?: string) => {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isZero = (value?: string) => {
  const parsed = toNumber(value);
  return parsed !== null && parsed === 0;
};

export const isFreeOpenRouterModel = (
  modelOrId: OpenRouterModel | string | undefined | null
) => {
  if (!modelOrId) return false;

  if (typeof modelOrId === "string") {
    return modelOrId.toLowerCase().includes(":free");
  }

  const id = modelOrId.id.toLowerCase();
  const name = (modelOrId.name || "").toLowerCase();
  if (id.includes(":free") || name.includes(":free")) {
    return true;
  }

  return isZero(modelOrId.pricing?.prompt) && isZero(modelOrId.pricing?.completion);
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

  let response = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
    headers: buildHeaders(true)
  });
  let source: CatalogSource = "authed";
  if (response.status === 401 || response.status === 403) {
    response = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
      headers: buildHeaders(false)
    });
    source = "fallback";
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
    .filter((model) => !isDeprecatedModel(model));
  cachedAt = now;
  lastSource = source;
  lastFetchedAt = new Date(now).toISOString();

  return cachedModels;
};

export const filterModelsForRole = (
  models: OpenRouterModel[],
  role: UserRole
) => {
  if (role !== FREE_MODEL_ONLY_ROLE) {
    return models;
  }

  return models.filter(isFreeOpenRouterModel);
};

const resolveFreeDefaultModel = async () => {
  if (
    isFreeOpenRouterModel(env.OPENROUTER_MODEL_DEFAULT_FREE) &&
    !isDeprecatedModel(env.OPENROUTER_MODEL_DEFAULT_FREE)
  ) {
    return env.OPENROUTER_MODEL_DEFAULT_FREE!;
  }

  if (
    isFreeOpenRouterModel(env.OPENROUTER_MODEL_DEFAULT) &&
    !isDeprecatedModel(env.OPENROUTER_MODEL_DEFAULT)
  ) {
    return env.OPENROUTER_MODEL_DEFAULT;
  }

  const models = await listOpenRouterModels();
  return models.find((m) => isFreeOpenRouterModel(m) && !isDeprecatedModel(m))?.id ?? null;
};

export const resolveModelForRole = async (
  role: UserRole,
  requestedModel?: string
): Promise<
  | { ok: true; model: string }
  | { ok: false; status: number; code: string; message: string }
> => {
  if (role !== FREE_MODEL_ONLY_ROLE) {
    if (requestedModel) {
      if (isDeprecatedModel(requestedModel)) {
        return {
          ok: false,
          status: 400,
          code: "MODEL_DEPRECATED",
          message: "The requested model is deprecated and no longer available."
        };
      }
      return { ok: true, model: requestedModel };
    }
    return { ok: true, model: env.OPENROUTER_MODEL_DEFAULT };
  }

  if (requestedModel) {
    if (isDeprecatedModel(requestedModel)) {
      return {
        ok: false,
        status: 400,
        code: "MODEL_DEPRECATED",
        message: "The requested model is deprecated and no longer available."
      };
    }

    if (isFreeOpenRouterModel(requestedModel)) {
      return { ok: true, model: requestedModel };
    }

    const models = await listOpenRouterModels();
    const matchedModel = models.find((item) => item.id === requestedModel);
    if (matchedModel && isFreeOpenRouterModel(matchedModel) && !isDeprecatedModel(matchedModel)) {
      return { ok: true, model: matchedModel.id };
    }

    return {
      ok: false,
      status: 403,
      code: "MODEL_NOT_ALLOWED",
      message: "Your current role can only use free models."
    };
  }

  const freeDefaultModel = await resolveFreeDefaultModel();
  if (!freeDefaultModel) {
    return {
      ok: false,
      status: 503,
      code: "FREE_MODEL_UNAVAILABLE",
      message: "No free model is configured or available right now."
    };
  }

  return { ok: true, model: freeDefaultModel };
};
