// Token-budgeted conversation history (payload only — DB untouched).
// Rebuilt from DB every turn, never cached per model, so memory survives
// model switches. Image bytes never count toward the char budget.
export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };
// Loose Prisma Message row — unknown fields ignored, quiz/images read defensively.
export type HistoryRow = {
  id?: unknown; role?: unknown; content?: unknown; images?: unknown;
  videos?: unknown; quiz?: unknown; status?: unknown;
};
export type BuildHistoryOpts = {
  systemPrompt?: string; existingUserMessageId?: string; recentKeep?: number; charBudget?: number;
};
export type HistoryStats = { promptChars: number; imageCount: number; droppedImages: number; truncated: number };
export const DEFAULT_RECENT_KEEP = 10;
export const DEFAULT_CHAR_BUDGET = 24000;
const LONG_LIMIT = 2000;
const HEAD_LEN = 1000;
const TAIL_LEN = 1000;
const COMPACT_LEN = 400;
const ANCHOR_LEN = 200;
type Item = { role: "system" | "user" | "assistant"; text: string; images: string[] };
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const storedImages = (v: unknown): string[] => strArr(v).filter((s) => s.startsWith("data:image/"));
const quizSummary = (quiz: unknown): string | null => {
  try {
    const q = typeof quiz === "string" ? JSON.parse(quiz) : quiz;
    if (!q || typeof q !== "object") return null;
    const o = q as Record<string, unknown>;
    if (!Array.isArray(o.questions)) return null;
    const list = o.questions as unknown[];
    const round = o.round ?? "?";
    const topic = typeof o.topic === "string" ? o.topic : "";
    const heads = list
      .slice(0, 3)
      .map((x) => String(typeof x === "string" ? x : (x as { question?: unknown })?.question ?? "").slice(0, 80))
      .filter((s) => s.length > 0);
    return `Quiz R${String(round)} "${topic}": ${list.length} questions` + (heads.length ? ` (${heads.join(" | ")})` : "");
  } catch { return null; }
};
const truncateLong = (t: string): string => {
  if (t.length <= LONG_LIMIT) return t;
  const removed = t.length - HEAD_LEN - TAIL_LEN;
  return `${t.slice(0, HEAD_LEN)}\n…[truncated ${removed} chars]…\n${t.slice(t.length - TAIL_LEN)}`;
};
const compact400 = (t: string): string =>
  t.length <= COMPACT_LEN ? t : `${t.slice(0, 350)}\n…[truncated ${t.length - 350} chars]…`;
const textLen = (m: OpenRouterMessage): number =>
  typeof m.content === "string" ? m.content.length
    : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
const getText = (m: OpenRouterMessage): string =>
  typeof m.content === "string" ? m.content
    : m.content.filter((p) => p.type === "text").map((p) => (p as OpenRouterTextPart).text).join("\n");
const setText = (m: OpenRouterMessage, t: string): void => {
  if (typeof m.content === "string") m.content = t;
  else { const p = m.content.find((x) => x.type === "text"); if (p && p.type === "text") p.text = t; }
};
export const buildHistoryMessages = (
  history: unknown,
  opts: BuildHistoryOpts = {},
): { messages: OpenRouterMessage[]; stats: HistoryStats } => {
  const recentKeep = opts.recentKeep ?? DEFAULT_RECENT_KEEP;
  const charBudget = opts.charBudget ?? DEFAULT_CHAR_BUDGET;
  let truncated = 0;
  let droppedImages = 0;
  const rows: HistoryRow[] = Array.isArray(history) ? (history as HistoryRow[]) : [];
  let sliced = rows;
  if (opts.existingUserMessageId) {
    const at = rows.findIndex((r) => String(r?.id ?? "") === opts.existingUserMessageId);
    if (at >= 0) sliced = rows.slice(0, at + 1);
  }
  const items: Item[] = [];
  for (const r of sliced) {
    const role = r?.role === "SYSTEM" ? "system" : r?.role === "ASSISTANT" ? "assistant" : "user";
    const raw = typeof r?.content === "string" ? r.content : r?.content == null ? "" : String(r.content);
    const status = typeof r?.status === "string" ? r.status : "";
    const imgs = strArr(r?.images);
    const vids = strArr(r?.videos);
    const userImgs = role === "user" ? storedImages(r?.images) : [];
    const qs = quizSummary(r?.quiz);
    if (qs && !raw.trim()) { items.push({ role: "assistant", text: qs, images: [] }); continue; }
    if (!raw.trim() && userImgs.length === 0 && imgs.length === 0 && vids.length === 0 && !qs) {
      if (status === "ERROR" || status === "STREAMING") continue;
    }
    if (role === "assistant" && (imgs.length > 0 || vids.length > 0)) {
      const cap = raw.trim().slice(0, 120);
      const parts: string[] = [];
      if (imgs.length > 0) parts.push(`[generated image for "${cap}"]`);
      if (vids.length > 0) parts.push("[generated video]");
      items.push({ role, text: parts.join("\n"), images: [] });
      continue;
    }
    items.push({ role, text: raw, images: userImgs });
  }
  let lastImg = -1;
  items.forEach((it, i) => { if (it.images.length > 0) lastImg = i; });
  items.forEach((it, i) => {
    if (i !== lastImg && it.images.length > 0) {
      droppedImages += it.images.length;
      it.images = [];
      it.text += "\n[earlier attached image omitted]";
    }
  });
  const imageCount = lastImg >= 0 ? items[lastImg].images.length : 0;
  for (const it of items) {
    const t = truncateLong(it.text);
    if (t !== it.text) { it.text = t; truncated++; }
  }
  const sysIdx = items.map((it, i) => (it.role === "system" ? i : -1)).filter((i) => i >= 0);
  const keepSys = sysIdx.length ? sysIdx[sysIdx.length - 1] : -1;
  const dropSys = new Set(sysIdx.filter((i) => i !== keepSys));
  dropSys.forEach((i) => {
    const note = items[i].text.trim();
    if (!note) return;
    let j = i + 1;
    while (j < items.length && (dropSys.has(j) || items[j].role !== "user")) j++;
    if (j >= items.length) { j = i + 1; while (j < items.length && dropSys.has(j)) j++; }
    if (j < items.length) items[j].text = `${items[j].text}\n[note: ${note}]`;
  });
  const kept = items.filter((_, i) => !dropSys.has(i));
  const messages: OpenRouterMessage[] = [];
  const head = (opts.systemPrompt || "").trim();
  if (head) messages.push({ role: "system", content: head });
  for (const it of kept) {
    if (it.role === "user" && it.images.length > 0) {
      const t = it.text.trim() ? it.text : "Describe the attached image(s) in detail.";
      messages.push({
        role: "user",
        content: [{ type: "text", text: t }, ...it.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
      });
    } else messages.push({ role: it.role, content: it.text });
  }
  if (kept.length > recentKeep) {
    const first = kept.find((it) => it.role === "user" && it.text.trim());
    const seed = (first?.text || "").trim().slice(0, ANCHOR_LEN);
    if (seed) {
      const anchor: OpenRouterMessage = { role: "user", content: seed };
      if (messages.length > 0 && messages[0].role === "system") messages.splice(1, 0, anchor);
      else messages.unshift(anchor);
    }
  }
  let promptChars = messages.reduce((n, m) => n + textLen(m), 0);
  let guard = messages.length * 3 + 16;
  while (promptChars > charBudget && guard-- > 0) {
    const recentFrom = Math.max(0, messages.length - recentKeep);
    let idx = -1;
    for (let i = 0; i < recentFrom; i++) { if (textLen(messages[i]) > COMPACT_LEN) { idx = i; break; } }
    if (idx >= 0) {
      setText(messages[idx], compact400(getText(messages[idx])));
      truncated++;
    } else {
      let best = -1; let bestLen = COMPACT_LEN;
      for (let i = recentFrom; i < messages.length; i++) {
        const l = textLen(messages[i]);
        if (l > bestLen) { bestLen = l; best = i; }
      }
      if (best >= 0) {
        setText(messages[best], compact400(getText(messages[best])));
        truncated++;
      } else {
        // All turns already ≤400ch yet still over budget (huge history / tiny
        // budget): drop the oldest non-system turn so the cap is truly hard.
        let drop = -1;
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].role !== "system") { drop = i; break; }
        }
        if (drop < 0) break;
        promptChars -= textLen(messages[drop]);
        messages.splice(drop, 1);
        truncated++;
        continue;
      }
    }
    promptChars = messages.reduce((n, m) => n + textLen(m), 0);
  }
  promptChars = messages.reduce((n, m) => n + textLen(m), 0);
  return { messages, stats: { promptChars, imageCount, droppedImages, truncated } };
};
