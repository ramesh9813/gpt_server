// Conversation history payload (rebuilt from DB every turn, never cached per
// model, so memory survives model switches). The full text history is always
// sent — nothing is compacted or dropped. Image bytes never ride old turns.
import { HISTORY } from "../../lib/constants";
import { prisma } from "../../lib/prisma";

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterAudioPart = { type: "input_audio"; input_audio: { data: string; format: string } };
// Original PDF document (OpenAI file part shape): providers that support
// document input read the real file — never extracted text.
export type OpenRouterFilePart = { type: "file"; file: { filename: string; file_data: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart | OpenRouterAudioPart | OpenRouterFilePart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };
// Loose Prisma Message row — unknown fields ignored, quiz/images/files read defensively.
export type HistoryRow = {
  id?: unknown; role?: unknown; content?: unknown; images?: unknown;
  videos?: unknown; quiz?: unknown; status?: unknown; files?: unknown;
};
export type BuildHistoryOpts = {
  systemPrompt?: string; existingUserMessageId?: string; recentKeep?: number;
};
export type HistoryStats = { promptChars: number; imageCount: number; droppedImages: number; truncated: number; audioCount: number; droppedAudio: number; droppedPdfs: number };
export const DEFAULT_RECENT_KEEP = HISTORY.DEFAULT_RECENT_KEEP;

const ANCHOR_LEN = HISTORY.ANCHOR_LEN;
type Item = { role: "system" | "user" | "assistant"; text: string; images: string[]; audio: string[]; pdfs: Array<{ name: string; dataUrl: string }> };
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const storedImages = (v: unknown): string[] => strArr(v).filter((s) => s.startsWith("data:image/"));
// Native audio payloads ride on files entries ({mime: audio/*, dataUrl}).
// Only the latest audio-bearing turn keeps bytes (same rule as images).
const storedAudio = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const mime = (e as { mime?: unknown }).mime;
    const dataUrl = (e as { dataUrl?: unknown }).dataUrl;
    if (typeof mime === "string" && mime.startsWith("audio/") && typeof dataUrl === "string" && dataUrl.startsWith("data:audio/")) {
      out.push(dataUrl);
    }
  }
  return out;
};
// Native PDF documents ride on files entries ({mime: application/pdf,
// dataUrl}). Same latest-turn rule as images/audio.
const storedPdfs = (v: unknown): Array<{ name: string; dataUrl: string }> => {
  if (!Array.isArray(v)) return [];
  const out: Array<{ name: string; dataUrl: string }> = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const mime = (e as { mime?: unknown }).mime;
    const dataUrl = (e as { dataUrl?: unknown }).dataUrl;
    const name = (e as { name?: unknown }).name;
    if (mime === "application/pdf" && typeof dataUrl === "string" && dataUrl.startsWith("data:application/pdf") && typeof name === "string") {
      out.push({ name, dataUrl });
    }
  }
  return out;
};
// rest passed through — the provider answers exactly if it can't).
const audioFormatOf = (dataUrl: string): string => {
  const sub = (/^data:audio\/([^;,]+)/.exec(dataUrl)?.[1] ?? "").toLowerCase();
  if (sub === "mpeg" || sub === "mp3") return "mp3";
  if (sub === "wav" || sub === "x-wav" || sub === "wave") return "wav";
  return sub.split("+")[0].split("-")[0] || "mp3";
};

// Every audio turn carries this in its text part: the model must evaluate
// the attached bytes themselves — and say so EXACTLY if it hears nothing,
// instead of inventing content. This is provider-agnostic: silent-drop
// gateways surface as [NO AUDIO RECEIVED], real listeners answer truly.
export const AUDIO_LISTEN_MARKER =
  "[An audio clip is attached as native audio input. Base your answer ONLY on what you actually hear in it. If you receive no audible audio, reply with exactly: [NO AUDIO RECEIVED] and nothing else.]";
export const quizSummary = (quiz: unknown): string | null => {
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
const textLen = (m: OpenRouterMessage): number =>
  typeof m.content === "string" ? m.content.length
  : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);

export const buildHistoryMessages = (
  history: unknown,
  opts: BuildHistoryOpts = {},
): { messages: OpenRouterMessage[]; stats: HistoryStats } => {
  const recentKeep = opts.recentKeep ?? DEFAULT_RECENT_KEEP;
  let truncated = 0;
  let droppedImages = 0;
  let droppedAudio = 0;
  let droppedPdfs = 0;
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
    const userAudio = role === "user" ? storedAudio((r as { files?: unknown })?.files) : [];
    const userPdfs = role === "user" ? storedPdfs((r as { files?: unknown })?.files) : [];
    const qs = quizSummary(r?.quiz);
    if (qs && !raw.trim()) { items.push({ role: "assistant", text: qs, images: [], audio: [], pdfs: [] }); continue; }
    if (!raw.trim() && userImgs.length === 0 && userAudio.length === 0 && userPdfs.length === 0 && imgs.length === 0 && vids.length === 0 && !qs) {
      if (status === "ERROR" || status === "STREAMING") continue;
    }
    if (role === "assistant" && (imgs.length > 0 || vids.length > 0)) {
      const cap = raw.trim().slice(0, 120);
      const parts: string[] = [];
      if (imgs.length > 0) parts.push(`[generated image for "${cap}"]`);
      if (vids.length > 0) parts.push("[generated video]");
      items.push({ role, text: parts.join("\n"), images: [], audio: [], pdfs: [] });
      continue;
    }
    items.push({ role, text: raw, images: userImgs, audio: userAudio, pdfs: userPdfs });
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
  let lastAud = -1;
  items.forEach((it, i) => { if (it.audio.length > 0) lastAud = i; });
  items.forEach((it, i) => {
    if (i !== lastAud && it.audio.length > 0) {
      droppedAudio += it.audio.length;
      it.audio = [];
      it.text += "\n[earlier attached audio omitted]";
    }
  });
  // PDFs follow the same rule: only the latest pdf-bearing turn keeps the
  // native document bytes (they are large; older turns keep their meta note).
  let lastPdf = -1;
  items.forEach((it, i) => { if (it.pdfs.length > 0) lastPdf = i; });
  items.forEach((it, i) => {
    if (i !== lastPdf && it.pdfs.length > 0) {
      droppedPdfs += it.pdfs.length;
      it.pdfs = [];
      it.text += "\n[earlier attached pdf omitted]";
    }
  });
  const imageCount = lastImg >= 0 ? items[lastImg].images.length : 0;
  const audioCount = lastAud >= 0 ? items[lastAud].audio.length : 0;
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
    if (it.role === "user" && (it.images.length > 0 || it.audio.length > 0 || it.pdfs.length > 0)) {
      const base = it.text.trim() ? it.text : "Describe the attached image(s) and audio in detail.";
      // Marker rides WITH the audio so the model evaluates the bytes (or
      // reports exactly that it hears nothing) — never invents content.
      const t = it.audio.length > 0 ? `${base}\n${AUDIO_LISTEN_MARKER}` : base;
      messages.push({
        role: "user",
        content: [
          { type: "text", text: t },
          ...it.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ...it.audio.map((url) => ({ type: "input_audio" as const, input_audio: { data: url.split(",")[1] ?? url, format: audioFormatOf(url) } })),
          ...it.pdfs.map((p) => ({
            type: "file" as const,
            file: { filename: p.name.toLowerCase().endsWith(".pdf") ? p.name : `${p.name}.pdf`, file_data: p.dataUrl },
          })),
        ],
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
  const promptChars = messages.reduce((n, m) => n + textLen(m), 0);
  return { messages, stats: { promptChars, imageCount, droppedImages, truncated, audioCount, droppedAudio, droppedPdfs } };
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
