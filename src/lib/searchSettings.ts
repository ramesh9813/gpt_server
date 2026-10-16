// Per-user search provider choice ("Search settings" section).
// Stored in userSettings.searchProvider: auto (default) | brave | exa |
// duckduckgo. Kept prisma-free-import? No — this module owns the lookup so
// websearch.ts stays dependency-light for unit tests.
import { prisma } from "./prisma";

export const SEARCH_PROVIDERS = ["auto", "brave", "exa", "youtube", "duckduckgo"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

// Display names for live progress lines ("Searching Brave for …").
export const SEARCH_PROVIDER_LABELS: Record<string, string> = {
  brave: "Brave",
  exa: "Exa",
  youtube: "YouTube",
  duckduckgo: "DuckDuckGo",
};

export const searchProviderLabel = (provider: string): string =>
  SEARCH_PROVIDER_LABELS[provider] ?? "web";

export const isSearchProvider = (v: unknown): v is SearchProvider =>
  typeof v === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(v);

// Auto order preserves previous behavior: Brave first (was the only keyed
// provider), then Exa, then keyless DuckDuckGo. YouTube joins auto only on
// video intent (see wantsYouTubeSearch in websearch.ts). An explicit pick
// still falls back down the chain when its key is missing/failing.
export const providerOrder = (provider: SearchProvider): Array<"brave" | "exa" | "youtube" | "duckduckgo"> => {
  const auto: Array<"brave" | "exa" | "duckduckgo"> = ["brave", "exa", "duckduckgo"];
  if (provider === "auto") return auto;
  if (provider === "youtube") return ["youtube", ...auto];
  if (!(auto as readonly string[]).includes(provider)) return auto;
  return [provider as "brave" | "exa" | "duckduckgo", ...auto.filter((p) => p !== provider)];
};

export const resolveSearchProvider = async (userId: string): Promise<SearchProvider> => {
  if (!userId) return "auto";
  try {
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    const v = (row as { searchProvider?: unknown } | null)?.searchProvider;
    return isSearchProvider(v) ? v : "auto";
  } catch {
    return "auto";
  }
};

// Dynamic result count ("Search settings" → number of websites). Stored in
// userSettings.searchDepth: 3/5/10/15/20 (default 5, the old hardcoded
// value). Anything else clamps into 3..20 so a stale row can never break
// or blow up a provider call.
export const SEARCH_DEPTH_DEFAULT = 5;
export const SEARCH_DEPTH_MIN = 3;
export const SEARCH_DEPTH_MAX = 20;

export const clampSearchDepth = (v: unknown): number => {
  const n = typeof v === "number" ? Math.floor(v) : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return SEARCH_DEPTH_DEFAULT;
  return Math.min(SEARCH_DEPTH_MAX, Math.max(SEARCH_DEPTH_MIN, n));
};

export const resolveSearchDepth = async (userId: string): Promise<number> => {
  if (!userId) return SEARCH_DEPTH_DEFAULT;
  try {
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    return clampSearchDepth((row as { searchDepth?: unknown } | null)?.searchDepth);
  } catch {
    return SEARCH_DEPTH_DEFAULT;
  }
};
