// Barrel re-export — split from openrouter.ts. No logic changes.
// Implementation lives in ./openrouter/*; this file preserves the original import path.
export type { CatalogSource, CatalogMeta, OpenRouterModel } from "./openrouter/catalog";
export { getCatalogMeta, listOpenRouterModels } from "./openrouter/catalog";
export {
  supportsImageGeneration,
  supportsVideoGeneration,
  isImageOnlyModel,
  isVideoOnlyModel,
} from "./openrouter/capabilities";
export { isFreeOpenRouterModel, filterModelsForRole, resolveModelForRole } from "./openrouter/models";
