import { BYOK_USER_AGENT, providerStatusError } from "./utils";
import type { ByokModelCatalog, ByokProvider } from "../byokTypes";

// Dropdowns must show the provider's FULL list — never silently truncate or
// drop entries because of an envelope quirk. Caps are a safety net only.
const MAX_MODELS = 2000;
const MAX_PAGES = 5;

// Providers disagree on the list envelope: standard OpenAI is {data:[{id}]},
// some gateways answer {models:[...]} or a bare array, with string ids,
// {id}, or {name} entries. Normalize every shape to plain ids.
const normalizeEntries = (list: any[]): string[] => {
  const ids: string[] = [];
  for (const m of list) {
    if (typeof m === "string") {
      if (m.trim()) ids.push(m.trim());
    } else if (m && typeof m === "object") {
      const id = m.id ?? m.name ?? m.model ?? m.slug;
      if (typeof id === "string" && id.trim()) ids.push(id.trim().replace(/^models\//, ""));
    }
  }
  return ids;
};

const readListEnvelope = (json: any): any[] => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.models)) return json.models;
  return [];
};

const collectFreeIds = (list: any[], allFree: boolean): Set<string> => {
  const freeIds = new Set<string>();
  if (allFree) for (const id of normalizeEntries(list)) freeIds.add(id);
  for (const m of list) {
    const id = typeof m === "string" ? m : String((m as any)?.id ?? (m as any)?.name ?? "");
    if (!id) continue;
    if (id.toLowerCase().endsWith(":free")) { freeIds.add(id); continue; }
    const p = (m as any)?.pricing;
    if (p && Number.parseFloat(String(p.prompt ?? p.input_per_1k ?? "")) === 0 && Number.parseFloat(String(p.completion ?? p.output_per_1k ?? "")) === 0) freeIds.add(id);
  }
  return freeIds;
};

export const fetchByokModels = async (provider: ByokProvider, apiKey = ""): Promise<ByokModelCatalog> => {
  if (provider.kind === "anthropic") {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { "User-Agent": BYOK_USER_AGENT, "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw await providerStatusError(response as any);
    const json = (await response.json()) as any;
    const list = readListEnvelope(json);
    return { models: normalizeEntries(list).slice(0, MAX_MODELS), freeIds: [] };
  }
  if (provider.kind === "gemini") {
    const response = await fetch(`${provider.baseUrl}/models?pageSize=500`, {
      headers: { "User-Agent": BYOK_USER_AGENT, ...(apiKey ? { "x-goog-api-key": apiKey } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw await providerStatusError(response as any);
    const json = (await response.json()) as any;
    const list: any[] = readListEnvelope(json);
    // Slim gateway lists omit supportedGenerationMethods — keep those entries
    // instead of dropping the whole catalog; only exclude entries that
    // explicitly lack generateContent.
    const models = list
      .filter((m) => {
        const methods = (m as any)?.supportedGenerationMethods;
        if (!Array.isArray(methods)) return true;
        return methods.includes("generateContent");
      })
      .map((m) => {
        if (typeof m === "string") return m;
        const name = (m as any)?.name ?? (m as any)?.id;
        return typeof name === "string" ? name.replace(/^models\//, "") : "";
      })
      .filter(Boolean)
      .slice(0, MAX_MODELS);
    return { models, freeIds: [] };
  }
  // OpenAI-compatible: follow `after`-cursor pagination so large catalogs
  // (aggregators list hundreds of models) arrive complete, then filter only
  // known non-chat families — never an allowlist that hides real chat models.
  const all: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = after
      ? `${provider.baseUrl}/models?limit=500&after=${encodeURIComponent(after)}`
      : `${provider.baseUrl}/models`;
    const response = await fetch(url, {
      headers: { "User-Agent": BYOK_USER_AGENT, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw await providerStatusError(response as any);
    const json = (await response.json()) as any;
    const list = readListEnvelope(json);
    all.push(...list);
    if (json?.has_more !== true || list.length === 0 || all.length >= MAX_MODELS) break;
    const last = list[list.length - 1];
    const lastId = typeof last === "string" ? last : String(last?.id ?? "");
    if (!lastId) break;
    after = lastId;
  }
  let ids = [...new Set(normalizeEntries(all))];
  if (provider.id === "openai") {
    ids = ids.filter(
      (id) =>
        /^(gpt-|o\d|chatgpt-|codex|computer-use)/i.test(id) &&
        !/(audio|realtime|image|tts|transcribe|embed|moderation|instruct)/i.test(id)
    );
  }
  const freeIds = collectFreeIds(all, provider.allModelsFree === true);
  return { models: ids.slice(0, MAX_MODELS), freeIds: [...freeIds] };
};
