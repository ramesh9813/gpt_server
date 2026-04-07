import { env } from "./config";
import { FREE_MODEL_ONLY_ROLE, UserRole } from "./userRoles";

type OpenRouterPricing = {
  prompt?: string;
  completion?: string;
};

export type OpenRouterModel = {
  id: string;
  name?: string;
  pricing?: OpenRouterPricing;
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

export const listOpenRouterModels = async () => {
  const now = Date.now();
  if (cachedModels.length > 0 && now - cachedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  let response = await fetch(`${env.OPENROUTER_BASE_URL}/models`, {
    headers: buildHeaders(true)
  });
  if (response.status === 401 || response.status === 403) {
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

  cachedModels = models.filter(
    (model: unknown): model is OpenRouterModel =>
      !!model &&
      typeof model === "object" &&
      typeof (model as OpenRouterModel).id === "string"
  );
  cachedAt = now;

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
  if (isFreeOpenRouterModel(env.OPENROUTER_MODEL_DEFAULT_FREE)) {
    return env.OPENROUTER_MODEL_DEFAULT_FREE!;
  }

  if (isFreeOpenRouterModel(env.OPENROUTER_MODEL_DEFAULT)) {
    return env.OPENROUTER_MODEL_DEFAULT;
  }

  const models = await listOpenRouterModels();
  return models.find(isFreeOpenRouterModel)?.id ?? null;
};

export const resolveModelForRole = async (
  role: UserRole,
  requestedModel?: string
): Promise<
  | { ok: true; model: string }
  | { ok: false; status: number; code: string; message: string }
> => {
  if (role !== FREE_MODEL_ONLY_ROLE) {
    return { ok: true, model: requestedModel || env.OPENROUTER_MODEL_DEFAULT };
  }

  if (requestedModel) {
    if (isFreeOpenRouterModel(requestedModel)) {
      return { ok: true, model: requestedModel };
    }

    const models = await listOpenRouterModels();
    const matchedModel = models.find((item) => item.id === requestedModel);
    if (matchedModel && isFreeOpenRouterModel(matchedModel)) {
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
