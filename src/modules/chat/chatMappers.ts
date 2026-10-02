import { combineFilesIntoPrompt } from "../../lib/fileAttachments";

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };

export const mapRole = (role: string): OpenRouterMessage["role"] => {
  if (role === "SYSTEM") return "system";
  if (role === "ASSISTANT") return "assistant";
  return "user";
};

export const buildUserContent = (text: string, images?: string[]): OpenRouterContent => {
  if (!images || images.length === 0) return text;
  const safeText = text && text.trim().length > 0 ? text : "Describe the attached image(s) in detail.";
  return [{ type: "text", text: safeText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))];
};

export const getStoredImages = (msg: unknown): string[] => {
  const raw = (msg as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.startsWith("data:image/"));
};

export const getStoredFiles = (msg: unknown): Array<{ name: string; mime: string; size: number; content: string }> => {
  const raw = (msg as { files?: unknown }).files;
  if (!Array.isArray(raw)) return [];
  return (raw as any[]).filter((v) => v && typeof v.name === "string" && typeof v.content === "string") as any;
};

export const resolveUserPromptForTurn = (
  userMessage: string | undefined,
  files: Array<{ name: string; mime: string; size: number; content: string }> | undefined
): string => {
  if (!Array.isArray(files) || files.length === 0) return userMessage ?? "";
  return combineFilesIntoPrompt(userMessage ?? "", files as any);
};

export const redactForLog = (messages: OpenRouterMessage[]) =>
  messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: (m.content as Array<OpenRouterTextPart | OpenRouterImagePart>).map((p) =>
        p.type === "image_url" ? { type: p.type, image_url: { url: `[omitted dataURL length=${p.image_url.url.length}]` } } : p
      ),
    };
  });
