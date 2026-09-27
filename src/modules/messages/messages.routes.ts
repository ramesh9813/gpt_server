import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { imagesSchema } from "../../lib/imageValidation";

const router = Router();

const createMessageSchema = z.object({
  content: z.string().min(1).max(8000),
  role: z.enum(["USER", "SYSTEM"]).optional(),
  images: imagesSchema,
});

// Quiz result shape (persisted on ASSISTANT messages via MCQ flow)
const quizQuestionSchema = z.object({
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(200)).length(4),
  answerIndex: z.number().int().min(0).max(3),
  explanation: z.string().max(300).optional(),
});

const quizSchema = z
  .object({
    round: z.number().int().min(1).optional(),
    topic: z.string().max(200).optional(),
    questions: z.array(quizQuestionSchema).max(50).optional(),
    // Allow selection tracking fields added by the client
    selections: z.record(z.number().int()).optional(),
    score: z.number().int().optional(),
  })
  .passthrough();

const updateMessageSchema = z
  .object({
    content: z.string().min(1).max(8000).optional(),
    quiz: quizSchema.optional(),
    pruneFollowing: z.boolean().optional(),
  })
  .refine((data) => data.content !== undefined || data.quiz !== undefined, {
    message: "content or quiz is required",
  });

router.get("/:id/messages", requireAuth, async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: req.params.id,
      userId: req.user!.id,
      deletedAt: null,
    },
  });

  if (!conversation) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
  });

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
        deletedAt: null,
      },
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: req.body.role || "USER",
        content: req.body.content,
        images: req.body.images ?? undefined,
        status: "COMPLETE",
      },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    return res.status(201).json({
      success: true,
      data: { message },
      message: "Message created",
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
        deletedAt: null,
      },
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Conversation not found" },
      });
    }

    const message = await prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
      },
    });

    if (!message) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" },
      });
    }

    const wantsContent = (req.body as { content?: unknown }).content !== undefined;
    const wantsQuiz = (req.body as { quiz?: unknown }).quiz !== undefined;
    if (wantsContent && message.role !== "USER") {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Message not found" },
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
      data,
    });

    let pruned = 0;
    if ((req.body as { pruneFollowing?: boolean }).pruneFollowing) {
      const result = await prisma.message.deleteMany({
        where: {
          conversationId,
          createdAt: { gt: message.createdAt },
        },
      });
      pruned = result.count;
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return res.json({
      success: true,
      data: { message: updated, pruned },
    });
  }
);

export default router;
