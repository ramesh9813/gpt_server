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
  }: {
    conversationId: string;
    userMessage?: string;
    existingUserMessageId?: string;
    images?: string[];
    model?: string;
    systemPrompt?: string;
    research?: boolean;
    artifact?: boolean;
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

  const resolvedModel = await resolveModelForRole(req.user!.role, model);
  if (!resolvedModel.ok) {
    return res.status(resolvedModel.status).json({
      success: false,
      error: { code: resolvedModel.code, message: resolvedModel.message },
    });
  }
  const selectedModel = resolvedModel.model;

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

  // MCQ quiz turn: `mcq <topic>` generates 10 MCQs as a quiz event (no stream).
  // Must run BEFORE the image branch so `mcq ...` never triggers image intent.
  if (!existingUserMessageId && wantsMcq(userMsgContent)) {
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
  if (!existingUserMessageId && (wantsVideo(userMsgContent) || isVideoOnlyModel(selectedModel))) {
    return sendVideoReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
    } as any);
  }

  // Image-generation turn: capability-checked, saved with images.
  if (!existingUserMessageId && (wantsImageGeneration(userMsgContent) || isImageOnlyModel(selectedModel))) {
    return sendImageReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
      history,
      images: userImages,
    } as any);
  }

  // Artifact turn: explicit client flag OR keyword auto-detect, fresh turns only
  // (skip on existingUserMessageId retry, mirroring image/mcq branches).
  // Continues the NORMAL streaming path — no special events, no new SSE type.
  const isArtifactTurn =
    !existingUserMessageId && (artifact === true || wantsArtifact(userMsgContent));

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

  // Token-budgeted history (payload only — DB untouched). Rebuilt from DB every
  // turn so memory survives model switches; retry slices to existingUserMessageId.
  const effectiveSystemPrompt = isArtifactTurn
    ? buildArtifactPrompt(artifactBrand, systemPrompt)
    : systemPrompt;
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
  });
});

export default router;
