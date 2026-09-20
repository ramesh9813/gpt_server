import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { resolveModelForRole } from "../../lib/openrouter";
import {
  buildUserContent,
  getStoredImages,
  mapRole,
  sendImageReply,
  streamOpenRouterCompletion,
  streamSchema,
  wantsImageGeneration,
  type OpenRouterMessage,
} from "./chat.service";

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
  }: {
    conversationId: string;
    userMessage?: string;
    existingUserMessageId?: string;
    images?: string[];
    model?: string;
    systemPrompt?: string;
    research?: boolean;
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

  // Image-generation turn: capability-checked, saved with images.
  if (!existingUserMessageId && wantsImageGeneration(userMsgContent)) {
    return sendImageReply(req, res, {
      assistantMessageId: assistantMsg.id,
      conversationId,
      prompt: userMsgContent,
      selectedModel,
    });
  }

  const messages: OpenRouterMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const message of history) {
    const role = mapRole(message.role);
    if (role === "user") {
      const stored = getStoredImages(message);
      messages.push({ role, content: buildUserContent(message.content, stored) });
    } else {
      messages.push({ role, content: message.content });
    }
  }

  return streamOpenRouterCompletion(req, res, {
    assistantMessageId: assistantMsg.id,
    conversationId,
    messages,
    selectedModel,
    research: research === true,
  });
});

export default router;
