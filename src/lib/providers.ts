// Dynamic provider registry — admin-created OpenAI-compatible endpoints.
//
// Static providers live in byok.ts (BYOK_PROVIDERS). At runtime we merge
// active Provider rows from Postgres so every BYOK path (chat, validate,
// models, direct) sees both without any restart. Cache is short-lived to
// keep DB load trivial.
import { prisma } from "./prisma";
import { BYOK_PROVIDERS, type ByokApiKind, type ByokProvider } from "./byok";

type ProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  kind: string;
  keyHint: string | null;
  keyPattern: string | null;
  keylessModels: boolean;
  models: string[];
  streamUsage: boolean;
  allModelsFree: boolean;
  isActive: boolean;
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,30}$/;

export const isValidProviderId = (id: string) => ID_RE.test(id);

export const coerceKind = (raw: unknown): ByokApiKind | null => {
  const k = String(raw ?? "").trim().toLowerCase();
  if (k === "openai" || k === "gemini" || k === "anthropic") return k as ByokApiKind;
  return null;
};

export const rowToByokProvider = (row: ProviderRow): ByokProvider => {
  let pattern: RegExp;
  if (row.keyPattern && row.keyPattern.trim()) {
    try {
      pattern = new RegExp(row.keyPattern.trim());
    } catch {
      pattern = /^.+$/;
    }
  } else {
    // Permissive when admin leaves it blank — verify via live /models.
    pattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,}$/;
  }
  const kind = coerceKind(row.kind) ?? "openai";
  return {
    id: row.id as any,
    name: row.name,
    kind,
    baseUrl: row.baseUrl,
    keyPattern: pattern,
    keyHint: row.keyHint || "your API key",
    keylessModels: row.keylessModels,
    models: Array.isArray(row.models) ? row.models : [],
    ...(row.streamUsage ? { streamUsage: true as const } : {}),
    ...(row.allModelsFree ? { allModelsFree: true as const } : {}),
  };
};

// ---- cache ---------------------------------------------------------------

let cache: { at: number; rows: ProviderRow[] } | null = null;
const TTL_MS = 30_000;

const fetchActiveRows = async (): Promise<ProviderRow[]> => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;
  try {
    const rows = (await (prisma as any).provider.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
    })) as ProviderRow[];
    cache = { at: now, rows };
    return rows;
  } catch {
    // Table missing before migration — behave as "no custom providers".
    return cache?.rows ?? [];
  }
};

export const clearProviderCache = () => {
  cache = null;
};

export const listAllByokProviders = async (): Promise<ByokProvider[]> => {
  const rows = await fetchActiveRows();
  const dynamic = rows.map(rowToByokProvider);
  const staticList = Object.values(BYOK_PROVIDERS) as ByokProvider[];
  const seen = new Set(dynamic.map((p) => p.id.toLowerCase()));
  const merged: ByokProvider[] = [...dynamic];
  for (const p of staticList) {
    if (!seen.has(String(p.id).toLowerCase())) merged.push(p);
  }
  return merged;
};

export const getByokProviderAsync = async (raw: unknown): Promise<ByokProvider | null> => {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  if (!id) return null;
  const rows = await fetchActiveRows();
  const hit = rows.find((r) => r.id.toLowerCase() === id);
  if (hit) return rowToByokProvider(hit);
  return (BYOK_PROVIDERS as Record<string, ByokProvider>)[id] ?? null;
};

export const getProviderRowById = async (id: string): Promise<ProviderRow | null> => {
  const norm = id.trim().toLowerCase();
  try {
    const row = await (prisma as any).provider.findUnique({ where: { id: norm } });
    return (row as ProviderRow) ?? null;
  } catch {
    return null;
  }
};

// Async version of parseByokHeaders so dynamic ids resolve.
export const parseByokHeadersAsync = async (
  req: { headers: Record<string, unknown> }
): Promise<import("./byok").ByokRequest | { error: string } | null> => {
  const providerRaw = String((req.headers as any)["x-byok-provider"] ?? "").trim();
  if (!providerRaw) return null;
  const provider = await getByokProviderAsync(providerRaw);
  if (!provider) return { error: `Unknown provider "${providerRaw}".` };
  let model = String((req.headers as any)["x-byok-model"] ?? "").trim();
  const prefix = `${provider.id}:`.toLowerCase();
  if (model.toLowerCase().startsWith(prefix)) model = model.slice(prefix.length).trim();
  if (!model || model.length > 200) return { error: "A model must be selected for the custom provider." };
  const apiKey = String((req.headers as any)["x-byok-key"] ?? "").trim();
  if (!apiKey || apiKey.length > 600) return { error: `A valid ${provider.name} API key is required.` };
  return { provider, model, apiKey };
};
