import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

// Vision: inline base64 dataURLs, no storage. Same limits as chat /stream.
const MAX_IMAGES = 3;
const MAX_IMAGE_STRING_LENGTH = 7 * 1024 * 1024;
const IMAGE_PREFIX_REGEX = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/;

const imageDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_STRING_LENGTH, "Each image must be under ~7MB")
  .refine((v) => IMAGE_PREFIX_REGEX.test(v.slice(0, 50)), {
    message: "images must be dataURL jpeg/png/webp/gif base64"
  });

const imagesSchema = z.array(imageDataUrlSchema).max(MAX_IMAGES).optional();

const createMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  role: z.enum(["USER", "SYSTEM"]).optional(),
  images: imagesSchema
});

const updateMessageSchema = z.object({
  content: z.string().min(1).max(8000).optional(),
  // Quiz passthrough so clients can persist selections (e.g. chosen answers)
  // on an ASSISTANT quiz message. Full replace of the quiz field server-side.
  quiz: z.record(z.any()).optional(),
  pruneFollowing: z.boolean().optional()
}).refine((data) => data.content !== undefined || data.quiz !== undefined, {
  message: "content or quiz is required"
});

router.get("/:id/messages", requireAuth, async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: req.params.id,
      userId: req.user!.id,
      deletedAt: null
    }
  });

  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Conversation not found" }
    });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" }
  });

  // images Json field (if present) is returned inline with each message.
  return res.json({ success: true, data: { messages } });
});

router.post(
  "/:id/messages",
  requireAuth,
  validateBody(createMessageSchema),
  async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: req.params.id,
        userId: req.user!.id,
        deletedAt: null
      }
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" }
      });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: req.body.role || "USER",
        content: req.body.content,
        images: req.body.images ?? undefined,
        status: "COMPLETE"
      }
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() }
    });

    return res.status(201).json({
      success: true,
      data: { message },
      message: "Message created"
    });
  }
);

router.patch(
  "/:conversationId/messages/:messageId",
  requireAuth,
  validateBody(updateMessageSchema),
  async (req, res) => {
    const { conversationId, messageId } = req.params;

    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        userId: req.user!.id,
        deletedAt: null
      }
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" }
      });
    }

    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId
      }
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" }
      });
    }

    // Preserve existing behavior: content edits are USER-only. Quiz replace is
    // allowed on any role (quiz messages are ASSISTANT) so clients can persist
    // selections. Content edit on non-USER stays a 404 (as before, when the
    // lookup itself was role-filtered).
    const wantsContent = (req.body as { content?: unknown }).content !== undefined;
    const wantsQuiz = (req.body as { quiz?: unknown }).quiz !== undefined;
    if (wantsContent && message.role !== "USER") {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" }
      });
    }

    const data: Record<string, unknown> = {};
    if (wantsContent) {
      data.content = (req.body as { content: string }).content;
    }
    if (wantsQuiz) {
      data.quiz = (req.body as { quiz: Record<string, unknown> }).quiz;
    }

    const updated = await (prisma.message.update as any)({
      where: { id: message.id },
      data
    });

    let pruned = 0;
    if ((req.body as { pruneFollowing?: boolean }).pruneFollowing) {
      const result = await prisma.message.deleteMany({
        where: {
          conversationId,
          createdAt: { gt: message.createdAt }
        }
      });
      pruned = result.count;
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    });

    return res.json({
      success: true,
      data: { message: updated, pruned }
    });
  }
);

export default router;
