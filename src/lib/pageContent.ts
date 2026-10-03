// Direct page fetch: when the user pastes URL(s) and asks for their detail
// ("detail this page", "summarize this link", or just the bare link), fetch
// the page itself instead of running a web search. SSRF-safe: only public
// http(s) hosts, capped size/count, timeouts on everything.
import type { WebResult } from "./websearch";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const MAX_URLS = 3;
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 8000;

const isPublicHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "metadata.google.internal") return false;
    if (h.startsWith("10.")) return false;
    if (h.startsWith("192.168.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h === "169.254.169.254") return false;
    if (h.endsWith(".internal") || h.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
};

export const extractPageUrls = (text: string): string[] => {  const out: string[] = [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    let url = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!isPublicHttpUrl(url)) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_URLS) break;
  }
  return out;
};

export const pageHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const DETAIL_WORDS_RE =
  /\b(detail|details|detailed|detailize|summar\w*|explain|elaborat\w*|read\s+this|open\s+this|this\s+(page|link|url|article|site|website)|content\s+of|what(?:'s| is) (in|on) (this|that)|inside\s+(this|that))\b/i;

// Explicit "detail this page/link" style asks, or a message that is nothing
// but link(s) — both mean "go read it", not "search the web".
export const wantsPageDetail = (text: string): boolean => {
  const t = (text || "").trim();
  if (!t) return false;
  const urls = extractPageUrls(t);
  if (urls.length === 0) return false;
  if (DETAIL_WORDS_RE.test(t)) return true;
  const withoutUrls = t.replace(/https?:\/\/[^\s<>"')\]]+/gi, "").replace(/[.,;:!?)\]]+$/, "").trim();
  return withoutUrls.length === 0;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

const htmlToText = (html: string): { title: string; text: string } => {
  let title = "";
  const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = decodeEntities(titleMatch[1].replace(/\s+/g, " ").trim()).slice(0, 200);
  const descMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i);
  const desc = descMatch ? decodeEntities(descMatch[1].replace(/\s+/g, " ").trim()) : "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const main = body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? body.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? body;
  const text = decodeEntities(main.replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { title, text: text || desc.slice(0, MAX_TEXT_CHARS) };
};

export const fetchPageContent = async (
  url: string
): Promise<{ title: string; url: string; text: string } | null> => {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_HTML_BYTES) return null;
    const html = await res.text();
    if (!html || html.length > MAX_HTML_BYTES * 2) return null;
    const { title, text } = htmlToText(html);
    if (!text) return null;
    return { title: title || url, url, text };
  } catch {
    return null;
  }
};

export type LinkedPages = {
  block: string;
  sources: Array<{ title: string; url: string }>;
};

// Fetch every pasted page (best-effort, parallel). Returns null unless at
// least one page yielded readable text.
export const fetchLinkedPages = async (text: string): Promise<LinkedPages | null> => {
  const urls = extractPageUrls(text);
  if (urls.length === 0 || !wantsPageDetail(text)) return null;
  const pages = await Promise.all(urls.map((u) => fetchPageContent(u)));
  const good = pages.filter((p): p is NonNullable<typeof p> => p !== null);
  if (good.length === 0) return null;
  const blocks = good.map(
    (p, i) => `Page ${i + 1} — ${p.title}\n${p.url}\n${p.text}`
  );
  const block =
    `The user shared ${good.length === 1 ? "this page" : "these pages"} and asked about its content. ` +
    `Answer from the page content below (quote or summarize as asked). ` +
    `If something is not in the pages, say so instead of guessing.\n\n${blocks.join("\n\n")}`;
  return {
    block,
    sources: good.map((p) => ({ title: p.title, url: p.url })),
  };
};

export type { WebResult };
