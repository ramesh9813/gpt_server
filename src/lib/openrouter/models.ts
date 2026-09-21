import { env } from "../config";
import { isDeprecatedModel } from "../modelThroughput";
import { FREE_MODEL_ONLY_ROLE, UserRole } from "../userRoles";
import { listOpenRouterModels, type OpenRouterModel } from "./catalog";

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
