// Model deprecation detection. Split from openrouter.ts. No logic changes.
import type { OpenRouterModel } from "./openrouter";

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
