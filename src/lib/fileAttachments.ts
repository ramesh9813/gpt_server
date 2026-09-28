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

export const summarizeFilesForHistory = (files: FileAttachment[]): string =>
  files.map((f) => `[${fileLabel(f)}: ${f.name}]`).join(" ");
