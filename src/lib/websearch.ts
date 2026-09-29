// Universal web search — no API key required (DuckDuckGo).
// Runs server-side so EVERY model/provider (OpenRouter built-in + all BYOK
// custom endpoints, Gemini, Anthropic, OpenAI-compat) gets live results.
// Results are injected into the prompt AND returned as {title,url} sources so
// the client can render the URL list at the bottom of the response.

export type WebResult = { title: string; url: string; snippet: string };

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

export const performWebSearch = async (query: string, max = 5): Promise<WebResult[]> => {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  // 1) HTML results (real web links) — primary.
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `q=${encodeURIComponent(q)}`,
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
  return (await ddgInstantAnswer(q)).slice(0, max);
};

// Prompt block injected ahead of the model call so even providers with no
// native search tool answer from live pages.
export const buildSearchContextBlock = (query: string, results: WebResult[]): string => {
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`
  );
  return (
    `Live web search results for "${query}":\n\n${lines.join("\n\n")}\n\n` +
    `Answer using these results. Cite claims with markdown links and end with a "Sources" list containing each URL above.`
  );
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
