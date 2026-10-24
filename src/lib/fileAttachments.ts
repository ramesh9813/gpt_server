import { z } from "zod";
import {
  MAX_FILE_CONTENT_CHARS,
  MAX_FILE_NAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_FILES,
  MAX_FILES_TOTAL_CHARS,
} from "./constants";

// ── validation schemas ─────────────────────────────────────────────────

export const fileAttachmentSchema = z.object({
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  mime: z.string().min(1).max(128),
  size: z.number().int().min(0).max(MAX_FILE_SIZE),
  content: z.string().min(1).max(MAX_FILES_TOTAL_CHARS + 4096),
  // Base64 audio payload (audio/* only): forwarded to the model as native
  // audio input, never inlined into text prompts. ~27MB cap ≈ 20MB file.
  dataUrl: z.string().max(30_000_000).optional(),
  attachmentId: z.string().min(1).max(64).optional(),
});

export const fileAttachmentsSchema = z
  .array(fileAttachmentSchema)
  .max(MAX_FILES)
  .optional();

export type FileAttachment = z.infer<typeof fileAttachmentSchema>;

// ── prompt building ────────────────────────────────────────────────────

// Short label for chat history, not metadata-heavy.
const fileLabel = (f: FileAttachment) =>
  f.mime.startsWith("image/") ? "image" : "file";

export const buildFilePromptBlocks = (
  files: FileAttachment[]
): string[] =>
  files.map((f) => {
    const header = `[${fileLabel(f)}: ${f.name} (${f.mime}, ${Math.round(f.size / 1024)}KB)]`;
    // Content may already be truncated by the client; guard total length.
    const body = f.content.length > MAX_FILE_CONTENT_CHARS
      ? `${f.content.slice(0, MAX_FILE_CONTENT_CHARS)}\n…[truncated ${f.content.length - MAX_FILE_CONTENT_CHARS} chars]…`
      : f.content;
    return `${header}\n${body}`;
  });

export const combineFilesIntoPrompt = (
  userText: string,
  files: FileAttachment[]
): string => {
  if (!files || files.length === 0) return userText;
  const blocks = buildFilePromptBlocks(files);
  let combined = blocks.join("\n\n");
  // Cap total files payload so history budgeting stays sane.
  if (combined.length > MAX_FILES_TOTAL_CHARS) {
    combined = `${combined.slice(0, MAX_FILES_TOTAL_CHARS)}\n…[files truncated — too large]…`;
  }
  const t = userText.trim();
  if (!t) return combined;
  return `${t}\n\n--- attached files ---\n${combined}`;
};

// Validated audio payload for model input: audio/* mime + data:audio/ URL
// within cap. Anything else (wrong mime, oversized) yields null so oversized
// or spoofed payloads never reach a provider — the meta note still goes.
export const audioDataUrlOf = (f: { mime?: unknown; dataUrl?: unknown }): string | null => {
  if (typeof f?.mime !== "string" || !f.mime.startsWith("audio/")) return null;
  if (typeof f?.dataUrl !== "string" || !f.dataUrl.startsWith("data:audio/")) return null;
  if (f.dataUrl.length > 30_000_000) return null;
  return f.dataUrl;
};

// Native PDF payload: the ORIGINAL document bytes (data:application/pdf),
// never extracted text. ~14M chars ≈ 10MB raw document.
export const pdfDataUrlOf = (f: { mime?: unknown; dataUrl?: unknown }): string | null => {
  if (typeof f?.mime !== "string" || f.mime !== "application/pdf") return null;
  if (typeof f?.dataUrl !== "string" || !f.dataUrl.startsWith("data:application/pdf")) return null;
  if (f.dataUrl.length > 14_000_000) return null;
  return f.dataUrl;
};

// PDF entries that promised native bytes but arrived without a payload
// (stale client, dropped field): answering from the bare meta note makes
// the model invent document content — fail loudly so the user re-sends.
// Intentionally-byteless PDFs (over-limit / unreadable notes) say so in
// their content and never match here.
export const pdfMissingBytes = (
  files: Array<{ name?: unknown; mime?: unknown; dataUrl?: unknown; content?: unknown }> | undefined
): string[] => {
  if (!Array.isArray(files) || files.length === 0) return [];
  const out: string[] = [];
  for (const f of files) {
    if ((f as { mime?: unknown })?.mime !== "application/pdf") continue;
    if (pdfDataUrlOf(f) !== null) continue;
    const content = typeof (f as { content?: unknown }).content === "string" ? (f as { content: string }).content : "";
    if (content.includes("attached as the original document")) {
      if (typeof f.name === "string") out.push(f.name);
    }
  }
  return out;
};

// Audio entries that need live bytes: no payload AND no legacy
// "[transcribed audio" text in the prompt. Answering those from a bare meta
// note makes the model hallucinate — callers fail loudly instead, naming
// the files (user re-sends and the model truly listens).
export const audioMissingBytes = (
  files: Array<{ name?: unknown; mime?: unknown; dataUrl?: unknown }> | undefined,
  promptText: string
): string[] => {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (typeof promptText === "string" && promptText.includes("[transcribed audio")) return [];
  const out: string[] = [];
  for (const f of files) {
    const mime = (f as { mime?: unknown })?.mime;
    const name = (f as { name?: unknown })?.name;
    if (typeof mime === "string" && mime.startsWith("audio/") && typeof name === "string") {
      if (audioDataUrlOf(f as { mime?: unknown; dataUrl?: unknown }) === null) out.push(name);
    }
  }
  return out;
};

export const summarizeFilesForHistory = (files: FileAttachment[]): string =>
  files.map((f) => `[${fileLabel(f)}: ${f.name}]`).join(" ");
