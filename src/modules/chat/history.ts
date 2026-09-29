// Token-budgeted conversation history (payload only — DB untouched).
// Rebuilt from DB every turn, never cached per model, so memory survives
// model switches. Image bytes never count toward the char budget.
import { HISTORY, LOW_HISTORY_BUDGET_PROVIDERS } from "../../lib/constants";
import { prisma } from "../../lib/prisma";

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
export const DEFAULT_RECENT_KEEP = HISTORY.DEFAULT_RECENT_KEEP;
export const DEFAULT_CHAR_BUDGET = HISTORY.DEFAULT_CHAR_BUDGET;

// Effective history budget for a turn: low-tier providers (tight per-minute
// input caps) get the tight budget; an explicit compactHistory request
// (client auto-trim near the limit) clamps to the emergency budget.
export const resolveHistoryBudget = (
  providerId?: string | null,
  compact?: boolean
): number => {
  const base =
    providerId &&
    LOW_HISTORY_BUDGET_PROVIDERS.includes(providerId.trim().toLowerCase())
      ? HISTORY.TIGHT_CHAR_BUDGET
      : HISTORY.DEFAULT_CHAR_BUDGET;
  return compact ? Math.min(base, HISTORY.COMPACT_CHAR_BUDGET) : base;
};
const LONG_LIMIT = HISTORY.LONG_LIMIT;
const HEAD_LEN = HISTORY.HEAD_LEN;
const TAIL_LEN = HISTORY.TAIL_LEN;
const COMPACT_LEN = HISTORY.COMPACT_LEN;
const ANCHOR_LEN = HISTORY.ANCHOR_LEN;
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
      let best = -1; let bestLen: number = COMPACT_LEN;
      for (let i = recentFrom; i < messages.length; i++) {
        const l = textLen(messages[i]);
        if (l > bestLen) { bestLen = l; best = i; }
      }
      if (best >= 0) {
        setText(messages[best], compact400(getText(messages[best])));
        truncated++;
      } else {
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

// How many of the newest messages keep their full media payloads.
// buildHistoryMessages only ever forwards image bytes from the single
// latest image-bearing turn (older ones become "[earlier attached image
// omitted]"), so fetching every historic base64 blob each turn is pure
// DB/TTFB cost that grows with chat length (multi-MB on image chats).
const HISTORY_FULL_TAKE = 10;

// Light history fetch for latency-critical paths (first token): text for
// all rows, full rows (images/videos/files/quiz) only for the newest
// HISTORY_FULL_TAKE plus an explicitly retried user message.
export const fetchHistoryRows = async (
  conversationId: string,
  opts: { includeUserMessageId?: string } = {}
): Promise<unknown[]> => {
  const [light, recent, extra] = await Promise.all([
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, content: true, status: true, quiz: true },
    }),
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: HISTORY_FULL_TAKE,
    }),
    opts.includeUserMessageId
      ? prisma.message.findMany({
          where: { conversationId, id: opts.includeUserMessageId },
        })
      : Promise.resolve([] as unknown[]),
  ]);
  if (recent.length === 0 && extra.length === 0) return light;
  const full = new Map<string, unknown>();
  for (const row of [...(recent as unknown[]), ...extra]) {
    full.set(String((row as { id?: unknown })?.id ?? ""), row);
  }
  return light.map((row: { id: unknown }) => full.get(String(row.id)) ?? row);
};
