// Image + video generation turns — split from chat.service.ts. No logic changes.
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { listOpenRouterModels, supportsImageGeneration, supportsVideoGeneration } from "../../lib/openrouter";
import { sseHead, sseSend, sseEnd, finishTextReply } from "./sse";
import { generateFollowups } from "./followups";

// Image-generation turn: uses the selected model when it can emit images,
// otherwise answers with a plain-text capability notice. Images are saved
// on the assistant message (Message.images) so they persist + re-render.
export const sendImageReply = async (
  req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; prompt: string; selectedModel: string }
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
        messages: [{ role: "user", content: prompt }],
        modalities: ["image", "text"],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      return finishText(`Image generation failed (${response.status}). Please try again.`);
    }
    const json = (await response.json()) as any;
    const msg = json?.choices?.[0]?.message ?? {};
    const urls: string[] = Array.isArray(msg.images)
      ? msg.images.map((im: any) => im?.image_url?.url).filter((u: unknown): u is string => typeof u === "string" && u.startsWith("data:image/"))
      : [];
    const caption: string = typeof msg.content === "string" ? msg.content : "";
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
export const sendVideoReply = async (
  req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; prompt: string; selectedModel: string }
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
        messages: [{ role: "user", content: prompt }],
        modalities: ["video", "text"],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      return finishText(`Video generation failed (${response.status}). Please try again.`);
    }
    const json = (await response.json()) as any;
    const msg = json?.choices?.[0]?.message ?? {};
    const isVideoUrl = (u: unknown): u is string =>
      typeof u === "string" && (u.startsWith("data:video/") || u.startsWith("https:"));
    // Free-text links only count when they look like hosted media, so plain
    // article links in a caption can never become phantom video players.
    const looksLikeMedia = (u: string): boolean =>
      /\.(mp4|webm|mov|m4v|ogv)([?#]|$)/i.test(u) ||
      /(video|clip|media|stream|vod|mp4|\.m3u8)/i.test(u);
    const unwrapVideoEntry = (v: unknown): string | undefined => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        const nested = obj["video_url"];
        if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>)["url"] === "string") {
          return (nested as Record<string, string>)["url"];
        }
        if (typeof obj["url"] === "string") return obj["url"] as string;
        if (typeof obj["b64_json"] === "string") return `data:video/mp4;base64,${obj["b64_json"] as string}`;
      }
      return undefined;
    };
    const fromVideos: string[] = Array.isArray((msg as Record<string, unknown>)["videos"])
      ? ((msg as Record<string, unknown>)["videos"] as unknown[])
          .map(unwrapVideoEntry)
          .filter(isVideoUrl)
      : [];
    const fromImages: string[] = Array.isArray((msg as Record<string, unknown>)["images"])
      ? ((msg as Record<string, unknown>)["images"] as unknown[])
          .map((im: unknown) => {
            if (typeof im === "string") return im;
            if (im && typeof im === "object") {
              const obj = im as Record<string, unknown>;
              const imageUrl = obj["image_url"];
              if (imageUrl && typeof imageUrl === "object" && typeof (imageUrl as Record<string, unknown>)["url"] === "string") {
                return (imageUrl as Record<string, string>)["url"];
              }
              return unwrapVideoEntry(im);
            }
            return undefined;
          })
          .filter(isVideoUrl)
      : [];
    const caption: string = typeof (msg as Record<string, unknown>)["content"] === "string" ? ((msg as Record<string, unknown>)["content"] as string) : "";
    const fromMarkdown: string[] = [];
    if (caption) {
      const mdLink = /\[.*?\]\((https:[^\s)]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = mdLink.exec(caption)) !== null) {
        if (isVideoUrl(m[1]) && looksLikeMedia(m[1])) fromMarkdown.push(m[1]);
      }
      const bare = /(https:[^\s)"']+)/g;
      while ((m = bare.exec(caption)) !== null) {
        const cleaned = m[1].replace(/[.,;:!?]+$/, "");
        if (isVideoUrl(cleaned) && looksLikeMedia(cleaned)) fromMarkdown.push(cleaned);
      }
      const dataLink = /(data:video\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+)/g;
      while ((m = dataLink.exec(caption)) !== null) {
        if (isVideoUrl(m[1])) fromMarkdown.push(m[1]);
      }
    }
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const u of [...fromVideos, ...fromImages, ...fromMarkdown]) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
      if (urls.length >= MAX_VIDEOS) break;
    }
    if (urls.length === 0) {
      return finishText(caption || "The model did not return a video. Please try again.");
    }
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
