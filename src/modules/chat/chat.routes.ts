import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { resolveModelForRole, isImageOnlyModel, isVideoOnlyModel } from "../../lib/openrouter";
import { buildArtifactPrompt } from "./artifact";
import {
  getStoredImages,
  redactForLog,
  sendImageReply,
  sendMcqReply,
  sendSimpleTextFinish,
  sendVideoReply,
  streamOpenRouterCompletion,
  streamSchema,
  wantsArtifact,
  wantsImageGeneration,
  wantsMcq,
  wantsVideo,
  type OpenRouterMessage,
} from "./chat.service";
import { buildHistoryMessages } from "./history";
import { parseByokHeaders } from "../../lib/byok";
import { streamByokCompletion } from "./byok";

const router = Router();

router.post("/stream", requireAuth, validateBody(streamSchema), async (req, res) => {
  const {
    conversationId,
    userMessage,
    existingUserMessageId,
    images,
    model,
    systemPrompt,
    research,
    artifact,
    webSearch,
  }: {
    conversationId: string;
    userMessage?: string;
    existingUserMessageId?: string;
    images?: string[];
    model?: string;
    systemPrompt?: string;
    research?: boolean;
    artifact?: boolean;
    webSearch?: boolean;
  } = req.body;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId: req.user!.id, deletedAt: null },
  });
  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });
  }

  // BYOK (bring-your-own-key): x-byok-* headers mean this chat turn runs on the
  // user's own provider key (stored only in their browser) instead of the
  // server-configured OpenRouter key. Absent headers = unchanged OpenRouter path.
  const byok = parseByokHeaders(req);
  if (byok && "error" in byok) {
    return res.status(400).json({
      success: false,
      error: { code: "BYOK_INVALID", message: byok.error },
    });
  }

  let selectedModel: string;
  if (byok) {
    selectedModel = `${byok.provider.id}:${byok.model}`;
  } else {
    const resolvedModel = await resolveModelForRole(req.user!.role, model);
    if (!resolvedModel.ok) {
      return res.status(resolvedModel.status).json({
        success: false,
        error: { code: resolvedModel.code, message: resolvedModel.message },
      });
    }
    selectedModel = resolvedModel.model;
  }

  let userMsgContent = userMessage || "";
  let userImages: string[] = Array.isArray(images) ? images : [];
  if (existingUserMessageId) {
    const existingMessage = await prisma.message.findFirst({
      where: { id: existingUserMessageId, conversationId, role: "USER" },
    });
    if (!existingMessage) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" },
      });
    }
    userMsgContent = existingMessage.content;
    // Retry path: re-hydrate images from DB so client doesn't resend base64.
    // Request images (if any) are ignored when existingUserMessageId is set.
    userImages = getStoredImages(existingMessage);
  } else if (userMessage || userImages.length > 0) {
    await prisma.message.create({
      data: {
        conversationId,
        role: "USER",
        content: userMessage ?? "",
        images: userImages.length > 0 ? userImages : undefined,
        status: "COMPLETE",
      },
    });
    userMsgContent = userMessage ?? "";
  }

  const trimmedTitle = userMsgContent.trim().replace(/\s+/g, " ");
  if (conversation.title === "New chat" && trimmedTitle.length > 0) {
    const derivedTitle = trimmedTitle.length > 60 ? `${trimmedTitle.slice(0, 57)}...` : trimmedTitle;
    await prisma.conversation.update({ where: { id: conversationId }, data: { title: derivedTitle } });
  }

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

  const assistantMsg = await prisma.message.create({
    data: { conversationId, role: "ASSISTANT", content: "", status: "STREAMING" },
  });

  // Artifact turn: explicit client flag OR keyword auto-detect.
  // Applies to retries too so an edited simulation prompt keeps streaming
  // with the artifact system prompt instead of degrading to plain chat.
  const isArtifactTurn =
    artifact === true || wantsArtifact(userMsgContent);

  // Brand-aware artifact prompt: load the user's brand, fallback "default",
  // tolerate missing row/column (older DBs without UserSettings.brand).
  let artifactBrand = "default";
  if (isArtifactTurn) {
    try {
      const settings = await prisma.userSettings.findUnique({
        where: { userId: req.user!.id },
        select: { brand: true },
      });
      const raw = (settings as { brand?: unknown } | null)?.brand;
      if (typeof raw === "string" && raw.trim()) artifactBrand = raw.trim().toLowerCase();
    } catch {
      artifactBrand = "default";
    }
  }
  const effectiveSystemPrompt = isArtifactTurn
    ? buildArtifactPrompt(artifactBrand, systemPrompt)
    : systemPrompt;

  // BYOK turn: plain-text chat streamed from the user's own provider key.
  // Quiz/image/video/web-search/research turns remain OpenRouter-driven and
  // are skipped here; nothing below changes when BYOK headers are absent.
  if (byok) {
    const { messages, stats } = buildHistoryMessages(history, {
      systemPrompt: effectiveSystemPrompt,
      existingUserMessageId,
    });
    console.log(
      `Sending messages to ${byok.provider.name} (BYOK, model=${byok.model}):`,
      JSON.stringify(redactForLog(messages as OpenRouterMessage[]), null, 2),
      "historyStats:",
      JSON.stringify(stats),
    );
    return streamByokCompletion(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      messages: messages as OpenRouterMessage[],
      byok,
    });
  }

  // MCQ quiz turn: `mcq <topic>` generates 10 MCQs as a quiz event (no stream).
  // Must run BEFORE the image branch so `mcq ...` never triggers image intent.
  // Applies to fresh turns AND edit/regenerate retries so an edited mcq prompt
  // stays a quiz instead of degrading to plain chat text.
  if (wantsMcq(userMsgContent)) {
    const topic = userMsgContent.replace(/^\s*mcq\b/i, "").trim();
    if (!topic) {
      return sendSimpleTextFinish(req, res, {
        assistantMessageId: assistantMsg.id,
        conversationId,
        selectedModel,
        text: "Tell me a topic for the quiz — e.g. `mcq solar system`.",
      });
    }
    const rawAsked = (conversation as unknown as { quizAsked?: unknown }).quizAsked;
    const askedBank: string[] = Array.isArray(rawAsked)
      ? rawAsked.filter((v): v is string => typeof v === "string")
      : [];
    let quizCount = 0;
    try {
      quizCount = await (prisma.message as any).count({
        where: { conversationId, NOT: { quiz: null } },
      });
    } catch {
      quizCount = 0;
    }
    const round = (typeof quizCount === "number" ? quizCount : 0) + 1;
    return sendMcqReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      topic,
      selectedModel,
      askedBank,
      round,
    });
  }

  // Video-generation turn: capability-checked, saved with videos.
  // Must run BEFORE the image branch so `generate video ...` never triggers image intent.
  // Applies to retries too so an edited video prompt stays a video turn.
  if (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel)) {
    return sendVideoReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
    } as any);
  }

  // Image-generation turn: capability-checked, saved with images.
  // Applies to retries too so an edited image prompt stays an image turn.
  if (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel)) {
    return sendImageReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
      images: userImages,
    } as any);
  }

  // Artifact turns continue the NORMAL streaming path below — no special
  // events, no new SSE type.

  // Token-budgeted history (payload only — DB untouched). Rebuilt from DB every
  // turn so memory survives model switches; retry slices to existingUserMessageId.
  const { messages, stats } = buildHistoryMessages(history, {
    systemPrompt: effectiveSystemPrompt,
    existingUserMessageId,
  });
  console.log(
    "Sending messages to OpenRouter:",
    JSON.stringify(redactForLog(messages as OpenRouterMessage[]), null, 2),
    "historyStats:",
    JSON.stringify(stats),
  );

  return streamOpenRouterCompletion(req, res, {
    assistantMessageId: assistantMsg.id,
    conversationId,
    messages: messages as OpenRouterMessage[],
    selectedModel,
    research: research === true,
    webSearch: webSearch === true,
    // Connector tools (Canva): resolved best-effort inside the streamer.
    // Disconnected users get [] and byte-identical behavior to before.
    canvaUserId: req.user!.id,
  });
});

export default router;
