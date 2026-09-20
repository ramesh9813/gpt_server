// Image + video generation turns — split from chat.service.ts. No logic changes
// except budgeted history (image) and compact prompt context (video).
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { listOpenRouterModels, supportsImageGeneration, supportsVideoGeneration } from "../../lib/openrouter";
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

// Video-generation turn: mirrors sendImageReply. Uses the selected model when
// it can emit video, otherwise answers with a plain-text capability notice.
// Videos are saved on the assistant message (Message.videos) so they persist
// + re-render. Veo-class models return hosted https: URLs; some models return
// data:video/* dataURLs — both are accepted.
const providerReason = (body: string): string => {
  try {
    const parsed = JSON.parse(body);
    const msg: unknown =
      parsed?.error?.message || parsed?.error || parsed?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 200);
  } catch {
    // fall through
  }
  const text = (body || "").trim();
  return text ? text.slice(0, 200) : "";
};

const buildVideoPrompt = async (conversationId: string, prompt: string, history?: unknown): Promise<string> => {
  try {
    let rows: unknown = history;
    if (!Array.isArray(rows)) {
      rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    }
    if (!Array.isArray(rows)) return prompt;
    let texts = (rows as Array<{ role?: unknown; content?: unknown }>)
      .filter((r) => r?.role === "USER")
      .map((r) => String(r?.content ?? "").trim())
      .filter((s) => s.length > 0);
    if (texts.length > 0 && texts[texts.length - 1] === prompt) texts = texts.slice(0, -1);
    const ctx = texts.slice(-3).map((s) => s.slice(0, 300));
    if (ctx.length === 0) return prompt;
    return `Conversation so far:\n${ctx.map((c) => `- ${c}`).join("\n")}\n\n${prompt}`;
  } catch {
    return prompt;
  }
};

export const sendVideoReply = async (
  req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; prompt: string; selectedModel: string; history?: unknown }
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
    if (!supportsVideoGeneration(selectedModel, catalog)) {
      return finishText(
        `This model (\`${selectedModel}\`) has no video-generation capability, so I can't create videos with it. Switch to a video-capable model (for example a Veo video model) and ask again.`
      );
    }
    // /videos takes a prompt string only — prepend compact recent user context.
    const effectivePrompt = await buildVideoPrompt(conversationId, prompt, (opts as { history?: unknown }).history);
    const submit = await fetch(`${env.OPENROUTER_BASE_URL}/videos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_ORIGIN,
        "X-Title": "ChatUI",
      },
      body: JSON.stringify({ model: selectedModel, prompt: effectivePrompt }),
      signal: AbortSignal.timeout(30000),
    });
    if (!submit.ok) {
      const body = await submit.text().catch(() => "");
      console.error("Video submit error:", submit.status, body.slice(0, 500));
      return finishText(
        `Video generation failed (${submit.status}). ${providerReason(body) || "Please try again."}`
      );
    }
    const job = (await submit.json()) as any;
    const jobId: string | undefined = job?.id;
    const pollingUrl: string | undefined =
      job?.polling_url || (jobId ? `${env.OPENROUTER_BASE_URL}/videos/${jobId}` : undefined);
    if (!jobId || !pollingUrl) {
      return finishText("Video generation failed (no job returned). Please try again.");
    }
    sendEvent("token", { delta: "Generating your video — this usually takes a minute or two… " });
    // Poll until completed. SSE comments keep the connection alive.
    const startedAt = Date.now();
    const DEADLINE_MS = 8 * 60 * 1000;
    let videoBytes: ArrayBuffer | null = null;
    let videoContentType = "video/mp4";
    for (;;) {
      if (res.writableEnded || res.destroyed) return undefined;
      if (Date.now() - startedAt > DEADLINE_MS) {
        return finishText("Video generation timed out. Please try again.");
      }
      await new Promise((r) => setTimeout(r, 5000));
      if (res.writableEnded || res.destroyed) return undefined;
      try {
        res.write(": ping\n\n");
      } catch {
        return undefined;
      }
      let statusRes: Response;
      try {
        statusRes = await fetch(pollingUrl, {
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "HTTP-Referer": env.APP_ORIGIN,
            "X-Title": "ChatUI",
          },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        continue;
      }
      if (!statusRes.ok) continue;
      const status = (await statusRes.json()) as any;
      const state: string = status?.status ?? "";
      if (state === "completed") {
        const contentUrls: string[] = Array.isArray(status?.unsigned_urls)
          ? (status.unsigned_urls as unknown[]).filter((u): u is string => typeof u === "string")
          : [];
        const downloadUrl =
          contentUrls[0] ?? `${env.OPENROUTER_BASE_URL}/videos/${jobId}/content`;
        try {
          const dl = await fetch(downloadUrl, {
            headers: {
              Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
              "HTTP-Referer": env.APP_ORIGIN,
              "X-Title": "ChatUI",
            },
            signal: AbortSignal.timeout(120000),
          });
          if (!dl.ok) {
            return finishText(`Video generation failed (download ${dl.status}). Please try again.`);
          }
          videoContentType = dl.headers.get("content-type") || "video/mp4";
          videoBytes = await dl.arrayBuffer();
        } catch (err: any) {
          return finishText("Video download failed. Please try again.");
        }
        break;
      }
      if (state === "failed" || state === "cancelled" || state === "expired") {
        const reason =
          typeof status?.error === "string" && status.error
            ? status.error.slice(0, 200)
            : "Please try again.";
        return finishText(`Video generation ${state}. ${reason}`);
      }
      // pending / in_progress → keep polling
    }
    if (!videoBytes || videoBytes.byteLength === 0) {
      return finishText("Video generation failed (empty result). Please try again.");
    }
    if (videoBytes.byteLength > 15 * 1024 * 1024) {
      return finishText("The generated video was too large to save. Try a shorter prompt.");
    }
    const dataUrl = `data:${videoContentType};base64,${Buffer.from(videoBytes).toString("base64")}`;
    const urls: string[] = [dataUrl];
    const caption = "";
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: caption, videos: urls, status: "COMPLETE", model: selectedModel } as any,
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    sendEvent("videos", { messageId: assistantMessageId, images: undefined, videos: urls });
    sendEvent("done", { messageId: assistantMessageId, usage: {} });
    try {
      const followups = await generateFollowups(selectedModel, `Generated video for: ${prompt}. ${caption}`);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({ where: { id: assistantMessageId }, data: { followups } });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("Followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    console.error("Video reply error:", err?.message || err);
    return finishText("Video generation failed. Please try again.");
  }
};
