// Universal web search — Brave AI grounding when BRAVE_API_KEY is set,
// otherwise the keyless DuckDuckGo chain.
// Runs server-side so EVERY model/provider (OpenRouter built-in + all BYOK
// custom endpoints, Gemini, Anthropic, OpenAI-compat) gets live results.
// Results are injected into the prompt AND returned as {title,url} sources so
// the client can render the URL list at the bottom of the response.

import { env } from "./config";

export type WebResult = { title: string; url: string; snippet: string; image?: string };

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const decodeDdgHref = (href: string): string => {
  try {
    if (href.startsWith("//")) href = `https:${href}`;
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return href;
  } catch {
    return href;
  }
};

const stripTags = (s: string): string =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const parseDdgHtml = (html: string, max: number): WebResult[] => {
  const out: WebResult[] = [];
  // html.duckduckgo.com/html/ marks each hit with result__a + result__snippet
  const re =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,2000}?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const href = m[1] ?? m[4] ?? "";
    const titleRaw = m[2] ?? m[5] ?? "";
    const snippetRaw = m[3] ?? "";
    const url = decodeDdgHref(stripTags(href));
    if (!/^https?:\/\//i.test(url)) continue;
    if (/duckduckgo\.com\/l\//i.test(url)) continue;
    const title = stripTags(titleRaw) || url;
    const snippet = stripTags(snippetRaw);
    if (out.some((r) => r.url === url)) continue;
    out.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 400) });
  }
  return out;
};

const ddgInstantAnswer = async (query: string): Promise<WebResult[]> => {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    const out: WebResult[] = [];
    if (j?.AbstractURL && j?.AbstractText) {
      out.push({
        title: String(j.Heading || j.AbstractSource || "Overview").slice(0, 200),
        url: String(j.AbstractURL),
        snippet: String(j.AbstractText).slice(0, 400),
      });
    }
    for (const t of j?.RelatedTopics ?? []) {
      const item = t?.FirstURL ? t : t?.Topics?.[0];
      if (item?.FirstURL && out.length < 5) {
        out.push({
          title: String(item.Text || item.FirstURL).split(" - ")[0].slice(0, 200),
          url: String(item.FirstURL),
          snippet: String(item.Text || "").slice(0, 400),
        });
      }
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
};

// Auto-decide: the model doesn't choose — prompts carrying an explicit
// search/news/recency intent trigger a lookup automatically, so "search ...",
// "today's news", "current price of ..." just work without the toggle.
const SEARCH_INTENT_RE =
  /\b(search(\s+(for|the|about|up))?|google|bing|duckduckgo|look\s*up|look it up|find\s+out|news|latest|recent(ly)?|today'?s?\s+(news|update|score|scores|price|prices|weather)|this\s+(week|month|year)|price|prices|cost|weather|score|scores|standings|stock|stocks|election|release\s+date|who\s+won|what\s+happened|update\s+me|trending)\b/i;
const CURRENT_PHRASE_RE =
  /\bcurrent\s+(news|events?|affairs|price|prices|status|year|date|score|weather|value)\b/i;
const RECENCY_QUESTION_RE =
  /\b(what|who|which|when|where)\b[^.?!]{0,80}\b(latest|newest|current|this\s+week|this\s+year|202[4-9]|20[3-9]\d)\b/i;

export const wantsWebSearch = (text: string): boolean => {
  const t = (text || "").slice(0, 1000);
  if (!t.trim()) return false;
  return SEARCH_INTENT_RE.test(t) || CURRENT_PHRASE_RE.test(t) || RECENCY_QUESTION_RE.test(t);
};

// Attached-document marker: the client inlines uploaded files as
// "[PDF: name]…", "[file: name …]", "[audio file: …]", "[video file: …]",
// "[transcribed audio …]". Such turns must be answered from the attachment
// itself — never auto-trigger transcript / page-fetch / web search on the
// attachment's own words (an explicit search toggle still applies).
const ATTACHED_DOC_RE = /\[(pdf|file|audio file|video file):|\[transcribed audio/i;

export const hasAttachedDocument = (text: string): boolean =>
  ATTACHED_DOC_RE.test(text || "");

// Image intent: only these turns get photo enrichment (og:image fetches +
// thumbnails). Every other search skips enrichment entirely — faster and
// imageless, as requested.
const SEARCH_IMAGE_RE =
  /\b(pics?|photos?|images?|pictures?|wallpapers?|posters?|galler(y|ies)|thumbnails?|logos?|icons?|selfies?|portraits?|looks?\s+like)\b/i;

export const wantsSearchImages = (text: string): boolean => {
  const t = (text || "").slice(0, 500);
  if (!t.trim()) return false;
  return SEARCH_IMAGE_RE.test(t);
};

// Video intent: "watch …", "trailer", "song", "vlog" and friends route to
// YouTube (auto mode) instead of web search. "Video of …" counts only
// without a generation verb — "generate a video of …" stays a creation
// prompt, not a watch request.
const YOUTUBE_EXPLICIT_RE =
  /\b(youtube|youtu\.?be|watch(\s+this|\s+the|\s+live)?|trailer|teaser|vlog|documentary|song|songs|music\s+video|lyric\s+video|live\s+stream)\b/i;
const YOUTUBE_VIDEOS_OF_RE = /\bvideos?\s+(of|about|on|for)\b/i;
const GENERATION_VERB_RE = /\b(generat\w*|creat\w*|make|making|draw|paint|render|produc\w*|direct|film|animate)\b/i;

export const wantsYouTubeSearch = (text: string): boolean => {
  const t = (text || "").slice(0, 1000);
  if (!t.trim()) return false;
  if (YOUTUBE_EXPLICIT_RE.test(t)) return true;
  return YOUTUBE_VIDEOS_OF_RE.test(t) && !GENERATION_VERB_RE.test(t);
};

// YouTube Data API v3 video search: key travels as the `key` query param
// (Data API keys are quota-limited — 100 units per search call — so results
// stay capped and failures fall through to the next provider).
const performYouTubeSearch = async (query: string, max: number): Promise<WebResult[]> => {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key) return [];
  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      order: "relevance",
      safeSearch: "moderate",
      maxResults: String(Math.min(Math.max(max, 1), 10)),
      key,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    const out: WebResult[] = [];
    for (const it of items) {
      const videoId = typeof it?.id?.videoId === "string" ? it.id.videoId : "";
      if (!videoId || out.some((r) => r.url.includes(videoId))) continue;
      const sn = it?.snippet ?? {};
      const title = String(sn?.title || "YouTube video").slice(0, 200);
      const channel = typeof sn?.channelTitle === "string" && sn.channelTitle ? ` — ${sn.channelTitle}` : "";
      const snippet = `${String(sn?.description || "").slice(0, 400)}${channel}`.slice(0, 600);
      out.push({ title, url: `https://www.youtube.com/watch?v=${videoId}`, snippet });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
};

// Brave AI grounding (llm/context): pre-extracted page content optimized
// for RAG, keyed by the X-Subscription-Token header. Lean budgets — this
// lands inside the model prompt, so ~3k tokens / 5 URLs max.
const performBraveSearch = async (query: string, max: number): Promise<WebResult[]> => {
  const key = env.BRAVE_API_KEY?.trim();
  if (!key) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      count: "10",
      maximum_number_of_urls: String(Math.min(Math.max(max, 1), 10)),
      maximum_number_of_tokens: "3000",
      maximum_number_of_snippets: "30",
      safesearch: "moderate",
      spellcheck: "true",
    });
    const res = await fetch(`https://api.search.brave.com/res/v1/llm/context?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": key,
        "User-Agent": UA,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    const items: any[] = Array.isArray(j?.grounding?.generic) ? j.grounding.generic : [];
    const out: WebResult[] = [];
    for (const g of items) {
      const url = typeof g?.url === "string" ? g.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      if (out.some((r) => r.url === url)) continue;
      const snippets: string[] = Array.isArray(g?.snippets)
        ? g.snippets.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
        : [];
      out.push({
        title: String(g?.title || url).slice(0, 200),
        url,
        snippet: snippets.join(" ").slice(0, 600),
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
};

export const performWebSearchWithProvider = async (
  query: string,
  max = 5,
  provider: "auto" | "brave" | "exa" | "youtube" | "duckduckgo" = "auto"
): Promise<{ hits: WebResult[]; provider: "brave" | "exa" | "youtube" | "duckduckgo" | "none" }> => {
  const q = query.trim().slice(0, 500);
  if (!q) return { hits: [], provider: "none" };
  // Provider chain: explicit pick first, then the rest in auto order.
  // YouTube leads auto only on video intent; missing keys and failures fall
  // through to the next provider.
  const base = (["brave", "exa", "duckduckgo"] as const).filter((p) => p !== provider);
  const order: ReadonlyArray<"brave" | "exa" | "youtube" | "duckduckgo"> =
    provider === "youtube"
      ? ["youtube", ...base]
      : provider === "auto" && wantsYouTubeSearch(q)
        ? ["youtube", "brave", "exa", "duckduckgo"]
        : provider === "auto" || (provider !== "brave" && provider !== "exa" && provider !== "duckduckgo")
          ? ["brave", "exa", "duckduckgo"]
          : [provider, ...base];
  // Parallel fan-out: every viable provider is queried AT ONCE (wall-clock
  // is the slowest provider, not the sum), then merged in priority order
  // with URL dedupe. Missing keys simply sit out.
  type ProviderName = "brave" | "exa" | "youtube" | "duckduckgo";
  const tasks: Array<{ name: ProviderName; run: () => Promise<WebResult[]> }> = [];
  for (const p of order) {
    if (p === "youtube" && env.YOUTUBE_API_KEY?.trim()) {
      tasks.push({ name: p, run: () => performYouTubeSearch(q, max) });
    } else if (p === "brave" && env.BRAVE_API_KEY?.trim()) {
      tasks.push({ name: p, run: () => performBraveSearch(q, max) });
    } else if (p === "exa" && env.EXA_API_KEY?.trim()) {
      tasks.push({ name: p, run: () => performExaSearch(q, max) });
    } else if (p === "duckduckgo") {
      tasks.push({ name: p, run: () => performDuckDuckGo(q, max) });
    }
  }
  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const normUrl = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}${parsed.search.toLowerCase()}`;
    } catch {
      return u.trim().toLowerCase().replace(/\/+$/, "");
    }
  };
  const seen = new Set<string>();
  const byProvider = new Map<ProviderName, WebResult[]>();
  tasks.forEach((t, i) => {
    const r = settled[i];
    byProvider.set(t.name, r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []);
  });
  const merged: WebResult[] = [];
  for (const p of order) {
    for (const h of byProvider.get(p) ?? []) {
      if (merged.length >= max) break;
      const key = normUrl(h.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
    }
    if (merged.length >= max) break;
  }
  const winner = order.find((p) => (byProvider.get(p) ?? []).length > 0);
  return { hits: merged, provider: winner ?? "none" };
};

export const performWebSearch = async (
  query: string,
  max = 5,
  provider: "auto" | "brave" | "exa" | "youtube" | "duckduckgo" = "auto"
): Promise<WebResult[]> => (await performWebSearchWithProvider(query, max, provider)).hits;

// Layered deep research: initial parallel fan-out, then up to `maxRounds`
// evaluate-and-deepen rounds. Each round asks the model what is still
// missing (given titles + snippets so far) and fans those follow-up queries
// out in parallel. Stops early on empty follow-ups, no new sources, abort,
// or the source cap. askModel/isAborted/onStage are injected so this stays
// provider-agnostic and unit-testable (no model/DB imports here).
export const DEEP_RESEARCH_MAX_ROUNDS = 2;
export const DEEP_RESEARCH_MAX_SOURCES = 80;

const parseFollowupQueries = (text: string): string[] => {
  const cleaned = (text || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
  if (!cleaned) return [];
  const collect = (raw: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      // fall through
    }
    return [];
  };
  let out = collect(cleaned);
  if (out.length === 0) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) out = collect(match[0]);
  }
  return out
    .map((q) => q.trim().slice(0, 200))
    .filter((q) => q.length > 2)
    .slice(0, 3);
};

export const deepResearchSearch = async (args: {
  query: string;
  depth: number;
  provider: "auto" | "brave" | "exa" | "youtube" | "duckduckgo";
  maxRounds?: number;
  maxSources?: number;
  askModel: (prompt: string) => Promise<string>;
  onStage: (text: string) => void;
  isAborted?: () => boolean;
}): Promise<{ hits: WebResult[]; roundsRun: number }> => {
  const maxRounds = args.maxRounds ?? DEEP_RESEARCH_MAX_ROUNDS;
  const maxSources = args.maxSources ?? DEEP_RESEARCH_MAX_SOURCES;
  const normUrl = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}${parsed.search.toLowerCase()}`;
    } catch {
      return u.trim().toLowerCase().replace(/\/+$/, "");
    }
  };
  const seen = new Set<string>();
  const merged: WebResult[] = [];
  const absorb = (hits: WebResult[]): number => {
    let added = 0;
    for (const h of hits) {
      if (merged.length >= maxSources) break;
      const key = normUrl(h.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(h);
      added++;
    }
    return added;
  };
  const first = await performWebSearchWithProvider(args.query, args.depth, args.provider);
  absorb(first.hits);
  let roundsRun = 0;
  for (let round = 1; round <= maxRounds; round++) {
    if (args.isAborted?.()) break;
    if (merged.length >= maxSources) break;
    // Evaluate: condense findings so far into the follow-up prompt.
    const digest = merged
      .slice(0, 30)
      .map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}`.slice(0, 400))
      .join("\n");
    const prompt =
      `Research question: ${args.query}\n\nFindings so far:\n${digest || "(none yet)"}\n\n` +
      `What 1-3 precise follow-up web searches would deepen this research (gaps, counter-evidence, specifics)? ` +
      `Reply with ONLY a JSON array of query strings, no other text. Reply [] if the findings already suffice.`;
    let followups: string[] = [];
    try {
      followups = parseFollowupQueries(await args.askModel(prompt));
    } catch {
      followups = [];
    }
    if (followups.length === 0) break;
    roundsRun = round;
    args.onStage(`Deepening research (round ${round}/${maxRounds}): ${followups.length} follow-up search${followups.length === 1 ? "" : "es"}…`);
    const perQuery = Math.max(10, Math.floor(args.depth / 2));
    const settled = await Promise.allSettled(
      followups.map((fq) => performWebSearchWithProvider(fq, perQuery, args.provider))
    );
    let added = 0;
    for (const s of settled) {
      if (s.status === "fulfilled") added += absorb(s.value.hits);
    }
    if (added === 0) break;
    args.onStage(`Round ${round} added ${added} new source${added === 1 ? "" : "s"} (${merged.length} total)…`);
  }
  return { hits: merged, roundsRun };
};

// Exa AI search (RAG-optimized highlights): POST /search with a Bearer key.
// Token-lean by design — highlights only, a few results max.
const performExaSearch = async (query: string, max: number): Promise<WebResult[]> => {
  const key = env.EXA_API_KEY?.trim();
  if (!key) return [];
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "User-Agent": UA,
      },
      body: JSON.stringify({
        query,
        numResults: Math.min(Math.max(max, 1), 10),
        contents: { highlights: true },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    const items: any[] = Array.isArray(j?.results) ? j.results : [];
    const out: WebResult[] = [];
    for (const r of items) {
      const url = typeof r?.url === "string" ? r.url : "";
      if (!/^https?:\/\//i.test(url)) continue;
      if (out.some((x) => x.url === url)) continue;
      const highlights: string[] = Array.isArray(r?.highlights)
        ? r.highlights.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
        : [];
      const text = typeof r?.text === "string" ? r.text : "";
      const snippet = (highlights.join(" ") || text).slice(0, 600);
      out.push({
        title: String(r?.title || url).slice(0, 200),
        url,
        snippet,
      });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
};

const performDuckDuckGo = async (query: string, max: number): Promise<WebResult[]> => {
  // 1) HTML results (real web links) — primary.
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(9000),
    });
    if (res.ok) {
      const html = await res.text();
      const hits = parseDdgHtml(html, max);
      if (hits.length > 0) return hits;
    }
  } catch {
    // fall through to instant-answer fallback
  }
  // 2) Instant-answer fallback (abstract + related) — no scraping.
  const instant = await ddgInstantAnswer(query);
  if (instant.length > 0) return instant.slice(0, max);
  // 3) Wikipedia fallback — reliable API, real page URLs, so a searched
  // answer almost always has bottom links even when DuckDuckGo is blocked.
  return wikipediaSearch(query, max);
};

// Wikipedia opensearch-style fallback via the query API (no key needed).
const wikipediaSearch = async (query: string, max: number): Promise<WebResult[]> => {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${max}&origin=*`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const j = (await res.json()) as any;
    const arr = Array.isArray(j?.query?.search) ? j.query.search : [];
    return arr.slice(0, max).map((r: any) => {
      const title = String(r?.title ?? query).slice(0, 200);
      return {
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: String(r?.snippet ?? "").replace(/<[^>]*>/g, "").slice(0, 400),
      };
    });
  } catch {
    return [];
  }
};

// Result photos: Open Graph / Twitter card image of a result page, resolved
// to an absolute URL. Pure (unit-tested) — network lives in enrich below.
export const extractOgImage = (html: string, pageUrl: string): string | null => {
  const pick = (re: RegExp): string | null => {
    const m = html.match(re);
    return m?.[1]?.trim() || null;
  };
  const raw =
    pick(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
    pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i);
  if (!raw || raw.startsWith("data:")) return null;
  try {
    const abs = new URL(raw, pageUrl).toString();
    if (!/^https?:\/\//i.test(abs) || abs.length > 500) return null;
    return abs;
  } catch {
    return null;
  }
};

export const youTubeVideoIdFromUrl = (url: string): string | null => {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1] ?? null;
};

// Photos for result hits, best-effort and parallel: YouTube videos get their
// free thumbnail; other pages get their og:image (one quick fetch each).
// Never throws — hits without a photo simply carry none.
export const enrichWithImages = async (hits: WebResult[], max = 5): Promise<WebResult[]> => {
  const jobs = hits.slice(0, max).map(async (h): Promise<WebResult> => {
    try {
      const ytId = youTubeVideoIdFromUrl(h.url);
      if (ytId) return { ...h, image: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` };
      const res = await fetch(h.url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: AbortSignal.timeout(6000),
        redirect: "follow",
      });
      if (!res.ok) return h;
      const type = res.headers.get("content-type") ?? "";
      if (type && !/text\/html/i.test(type)) {
        // Direct image link — use it as its own photo.
        if (/image\//i.test(type)) return { ...h, image: h.url };
        return h;
      }
      const html = await res.text();
      if (!html) return h;
      const image = extractOgImage(html.slice(0, 300000), h.url);
      return image ? { ...h, image } : h;
    } catch {
      return h;
    }
  });
  const enriched = await Promise.all(jobs);
  return [...enriched, ...hits.slice(max)];
};

// Prompt block injected ahead of the model call so even providers with no
// native search tool answer from live pages.
export const buildSearchContextBlock = (query: string, results: WebResult[]): string => {
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`
  );
  return (
    `Live web search results for "${query}":\n\n${lines.join("\n\n")}\n\n` +
    `Answer using these results and cite claims with markdown links. ` +
    `Do NOT write a Sources or References section at the end — the app renders the source list below the answer automatically.`
  );
};

// One scrolling line per source: "2/5 kathmandupost.com — Title…".
// The client keeps the last 3 stage lines, so sources auto-scroll past one
// after another as they arrive instead of a single "Reading N sources" line.
export const stageLineForSource = (index: number, total: number, title: string, url: string, snippet = ""): string => {
  // Live stage lines show the website URL plus its content detail (snippet),
  // not just host + title — the user watches what each source actually says.
  const detail = (snippet || title || "").replace(/\s+/g, " ").trim().slice(0, 140);
  return `${index + 1}/${total} ${url}${detail ? ` — ${detail}` : ""}…`;
};
// Footer guarantees the searched-page URLs sit at the bottom of the bubble
// even when the model omits them — client Sources panel + persisted row use
// the same list via the `sources` SSE event.
export const appendSourcesFooter = (
  content: string,
  sources: Array<{ title: string; url: string }>
): string => {
  if (sources.length === 0) return content;
  const hasAll = sources.every((s) => content.includes(s.url));
  if (hasAll) return content;
  const lines = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`);
  return `${content.replace(/\s+$/, "")}\n\nSources:\n${lines.join("\n")}`;
};

// A trailing "Sources"/"References" section the model wrote itself (titles,
// often without URLs). Matches headings like `Sources:`, `**Sources:**`,
// `**Sources**:`, `## References` — case-insensitive, colon/bold markers in
// either order.
const SOURCES_HEADING_RE = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*|__)?(sources?|references?)(?:\s*:?\s*(?:\*\*|__)?)*\s*(?:\n|$)/gi;

// One list only: when the model already ended with its own Sources section
// AND we hold structured sources (real URLs), swap its section for the
// canonical URL list instead of appending a second one. Conservative: the
// tail must look like a reference list (list items / links / short lines),
// otherwise the text is left untouched.
export const ensureSingleSourcesSection = (
  content: string,
  sources: Array<{ title: string; url: string }>,
  appendIfMissing = true
): string => {
  if (sources.length === 0) return content;
  const fallback = appendIfMissing ? appendSourcesFooter(content, sources) : content;
  const text = content.replace(/\s+$/, "");
  SOURCES_HEADING_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = SOURCES_HEADING_RE.exec(text)) !== null) last = m;
  if (!last) return fallback;
  const tail = text.slice(last.index + last[0].length);
  if (!tail.trim() || tail.length > 2000) return fallback;
  const lines = tail.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return fallback;
  const listLike = (l: string): boolean =>
    /^\s*(?:[-*•–—]|\d+[.)\]}])\s*\S/.test(l) ||
    /\[[^\]]+\]\([^)]+\)/.test(l) ||
    /https?:\/\/\S/.test(l) ||
    /^\s*[\w-]+(\.[\w-]+)+\b/.test(l) ||
    l.trim().length <= 160;
  const strongListLike = (l: string): boolean =>
    /^\s*(?:[-*•–—]|\d+[.)\]}])\s*\S/.test(l) ||
    /\[[^\]]+\]\([^)]+\)/.test(l) ||
    /https?:\/\/\S/.test(l);
  // Bare title lines ("The Kathmandu Post") carry no markers — accept them
  // only as a group: 2+ short lines, none ending like a prose sentence.
  const titleLike = (l: string): boolean => {
    const t = l.trim();
    return t.length > 0 && t.length <= 120 && !/[.?!…]\s*$/.test(t);
  };
  const looksLikeList =
    lines.every(listLike) &&
    (lines.some(strongListLike) ||
      (lines.length >= 2 && lines.every(titleLike)));
  if (!looksLikeList) return fallback;
  // The Sources panel below the answer owns the canonical list — a
  // model-written trailing section is removed so sources never render twice.
  return text.slice(0, last.index).replace(/\s+$/, "");
};
