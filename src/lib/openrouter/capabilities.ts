import { cachedModels, type OpenRouterModel } from "./catalog";

export const supportsImageGeneration = (
  modelOrId: OpenRouterModel | string | undefined | null,
  catalog?: OpenRouterModel[]
): boolean => {
  const entry =
    typeof modelOrId === "string"
      ? (catalog ?? cachedModels).find((m) => m.id === modelOrId)
      : modelOrId;
  const out = entry?.architecture?.output_modalities;
  if (Array.isArray(out) && out.includes("image")) return true;
  if (typeof modelOrId === "string") {
    const s = modelOrId.toLowerCase();
    if (
      s.includes("imagine-image") ||
      s.includes("-image") ||
      s.includes("image-") ||
      s.includes("flux") ||
      s.includes("midjourney") ||
      s.includes("dall-e")
    ) {
      return true;
    }
  }
  return false;
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
  if (Array.isArray(out) && out.includes("video")) return true;
  if (typeof modelOrId === "string") {
    const s = modelOrId.toLowerCase();
    if (
      s.includes("imagine-video") ||
      s.includes("-video") ||
      s.includes("video-") ||
      s.includes("veo") ||
      s.includes("sora") ||
      s.includes("kling")
    ) {
      return true;
    }
  }
  return false;
};

export const isImageOnlyModel = (
  modelOrId: OpenRouterModel | string | undefined | null,
  catalog?: OpenRouterModel[]
): boolean => {
  const entry =
    typeof modelOrId === "string"
      ? (catalog ?? cachedModels).find((m) => m.id === modelOrId)
      : modelOrId;
  const out = entry?.architecture?.output_modalities;
  if (Array.isArray(out) && out.includes("image") && !out.includes("text")) return true;
  if (typeof modelOrId === "string") {
    const s = modelOrId.toLowerCase();
    if (s.includes("imagine-image") || s.includes("flux") || s.includes("midjourney")) {
      return true;
    }
  }
  return false;
};

export const isVideoOnlyModel = (
  modelOrId: OpenRouterModel | string | undefined | null,
  catalog?: OpenRouterModel[]
): boolean => {
  const entry =
    typeof modelOrId === "string"
      ? (catalog ?? cachedModels).find((m) => m.id === modelOrId)
      : modelOrId;
  const out = entry?.architecture?.output_modalities;
  if (Array.isArray(out) && out.includes("video") && !out.includes("text")) return true;
  if (typeof modelOrId === "string") {
    const s = modelOrId.toLowerCase();
    if (
      s.includes("imagine-video") ||
      s.includes("kling") ||
      s.includes("sora") ||
      s.includes("veo")
    ) {
      return true;
    }
  }
  return false;
};
