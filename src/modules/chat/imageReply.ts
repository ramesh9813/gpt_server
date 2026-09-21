// Image-generation turn — split from mediaReply.ts. No logic changes.
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { listOpenRouterModels, supportsImageGeneration } from "../../lib/openrouter";
import { sseHead, sseSend, sseEnd, finishTextReply } from "./sse";
import { generateFollowups } from "./followups";
import { buildHistoryMessages } from "./history";

// Local to avoid a chat.service <-> mediaReply import cycle.
const toUserContent = (text: string, images?: string[]): string | Array<{ type: string; text?: string; image_url?: { url: string } }> => {
  if (!images || images.length === 0) return text;
  const safe = text && text.trim().length > 0 ? text : "Generate an image for this request.";
  return [{ type: "text", text: safe }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
};

// Image-generation turn: uses the selected model when it can emit images,
// otherwise answers with a plain-text capability notice. Images are saved
// on the assistant message (Message.images) so they persist + re-render.
export const sendImageReply = async (
  req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; prompt: string; selectedModel: string; history?: unknown; images?: string[] }
) => {
  const { assistantMessageId, conversationId, prompt, selectedModel } = opts;
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  const finishText = async (text: string) => {
    return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
  };
  try {
    const catalog = await listOpenRouterModels().catch(() => []);
    if (!supportsImageGeneration(selectedModel, catalog)) {
      return finishText(
        `This model (\`${selectedModel}\`) has no image-generation capability, so I can't create pictures with it. Switch to an image-capable model (for example a gpt-image or Gemini image model) and ask again.`
      );
    }
    // Budgeted history: compact prior turns, current prompt (with current-turn
    // images) last. History comes from routes when available, else refetched.
    let historyMessages: Array<{ role: "user" | "assistant" | "system"; content: any }> | null = null;
    try {
      let rows: unknown = (opts as { history?: unknown }).history;
      if (!Array.isArray(rows)) {
        rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
      }
      const arr = Array.isArray(rows) ? (rows as unknown[]) : [];
      let base = arr;
      if (arr.length > 0) {
        const last = arr[arr.length - 1] as { role?: unknown; content?: unknown };
        if (last?.role === "USER" && typeof last?.content === "string" && last.content === prompt) {
          base = arr.slice(0, -1);
        }
      }
      const built = buildHistoryMessages(base, {});
      const rawImgs = (opts as { images?: unknown }).images;
      const currentImages = Array.isArray(rawImgs)
        ? rawImgs.filter((v): v is string => typeof v === "string" && v.startsWith("data:image/"))
        : [];
      const currentContent = toUserContent(prompt, currentImages);
      historyMessages = [...(built.messages as any), { role: "user" as const, content: currentContent as any }];
    } catch {
      historyMessages = null;
    }
    const messages = historyMessages && historyMessages.length > 0 ? historyMessages : [{ role: "user" as const, content: prompt }];
    let urls: string[] = [];
    let caption = "";

    try {
      const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_ORIGIN,
          "X-Title": "ChatUI",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          modalities: ["image", "text"],
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (response.ok) {
        const json = (await response.json()) as any;
        const msg = json?.choices?.[0]?.message ?? {};
        urls = Array.isArray(msg.images)
          ? msg.images
              .map((im: any) => im?.image_url?.url || im?.url)
              .filter(
                (u: unknown): u is string =>
                  typeof u === "string" &&
                  (u.startsWith("data:image/") || u.startsWith("https://") || u.startsWith("http://"))
              )
          : [];
        caption = typeof msg.content === "string" ? msg.content : "";
      }
    } catch {
      // Fall through to dedicated images endpoint
    }

    if (urls.length === 0) {
      try {
        const imgRes = await fetch(`${env.OPENROUTER_BASE_URL}/images`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": env.APP_ORIGIN,
            "X-Title": "ChatUI",
          },
          body: JSON.stringify({
            model: selectedModel,
            prompt,
          }),
          signal: AbortSignal.timeout(90000),
        });
        if (imgRes.ok) {
          const imgJson = (await imgRes.json()) as any;
          if (Array.isArray(imgJson?.data)) {
            for (const item of imgJson.data) {
              if (typeof item?.b64_json === "string") {
                const mime = item.media_type || "image/png";
                urls.push(`data:${mime};base64,${item.b64_json}`);
              } else if (typeof item?.url === "string") {
                urls.push(item.url);
              }
            }
          }
        }
      } catch {
        // Handled below if urls.length === 0
      }
    }

    if (urls.length === 0) {
      return finishText(caption || "The model did not return an image. Please try again.");
    }
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: caption, images: urls, status: "COMPLETE", model: selectedModel },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    sendEvent("images", { messageId: assistantMessageId, images: urls });
    sendEvent("done", { messageId: assistantMessageId, usage: {} });
    try {
      const followups = await generateFollowups(selectedModel, `Generated image for: ${prompt}. ${caption}`);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({ where: { id: assistantMessageId }, data: { followups } });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("Followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    console.error("Image reply error:", err?.message || err);
    return finishText("Image generation failed. Please try again.");
  }
};
