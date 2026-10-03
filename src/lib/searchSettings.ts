// Per-user search provider choice ("Search settings" section).
// Stored in userSettings.searchProvider: auto (default) | brave | exa |
// duckduckgo. Kept prisma-free-import? No — this module owns the lookup so
// websearch.ts stays dependency-light for unit tests.
import { prisma } from "./prisma";

export const SEARCH_PROVIDERS = ["auto", "brave", "exa", "duckduckgo"] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export const isSearchProvider = (v: unknown): v is SearchProvider =>
  typeof v === "string" && (SEARCH_PROVIDERS as readonly string[]).includes(v);

// Auto order preserves previous behavior: Brave first (was the only keyed
// provider), then Exa, then keyless DuckDuckGo. An explicit pick still falls
// back down the chain when its key is missing/failing.
export const providerOrder = (provider: SearchProvider): Array<"brave" | "exa" | "duckduckgo"> => {
  const auto: Array<"brave" | "exa" | "duckduckgo"> = ["brave", "exa", "duckduckgo"];
  if (provider === "auto" || !auto.includes(provider as "brave")) return auto;
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
