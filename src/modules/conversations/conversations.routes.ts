import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

const createSchema = z.object({
  folderId: z.string().optional()
}).optional().default({});

const updateSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  folderId: z.string().optional().nullable(),
  archived: z.boolean().optional()
});

router.get("/", requireAuth, async (req, res) => {
  const search = (req.query.search as string) || "";
  const folderId = req.query.folderId as string;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200); // Increased limit for easier grouping
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        userId: req.user!.id,
        deletedAt: null,
        folderId: folderId === "null" ? null : folderId || undefined,
        title: search
          ? { contains: search, mode: "insensitive" }
          : undefined
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit
    }),
    prisma.conversation.count({
      where: {
        userId: req.user!.id,
        deletedAt: null,
        folderId: folderId === "null" ? null : folderId || undefined,
        title: search
          ? { contains: search, mode: "insensitive" }
          : undefined
      }
    })
  ]);

  return res.json({
    success: true,
    data: { items },
    meta: { page, limit, total }
  });
});

router.post("/", requireAuth, validateBody(createSchema), async (req, res) => {
  const { folderId } = req.body;
  const conversation = await prisma.conversation.create({
    data: {
      userId: req.user!.id,
      folderId: folderId || null,
      title: "New chat"
    }
  });

  return res.status(201).json({
    success: true,
    data: { conversation },
    message: "Conversation created"
  });
});

router.get("/:id", requireAuth, async (req, res) => {
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

  return res.json({ success: true, data: { conversation } });
});

router.patch(
  "/:id",
  requireAuth,
  validateBody(updateSchema),
  async (req, res) => {
    const { title, archived, folderId } = req.body;
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

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: title ?? conversation.title,
        folderId: folderId !== undefined ? folderId : conversation.folderId,
        archivedAt: archived
          ? new Date()
          : archived === false
          ? null
          : conversation.archivedAt
      }
    });

    return res.json({
      success: true,
      data: { conversation: updated },
      message: "Conversation updated"
    });
  }
);

router.delete("/:id", requireAuth, async (req, res) => {
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

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { deletedAt: new Date() }
  });

  return res.json({ success: true, data: {}, message: "Conversation deleted" });
});

export default router;
