import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { sanitizeTuningPrompt, TUNING_MAX_LENGTH } from "../../lib/tuning";

const router = Router();

const createSchema = z.object({
  folderId: z.string().optional()
}).optional().default({});

const updateSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  folderId: z.string().optional().nullable(),
  archived: z.boolean().optional(),
  pinned: z.boolean().optional()
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
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
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
  // IDOR guard: folder must belong to the caller.
  if (folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: folderId, userId: req.user!.id },
    });
    if (!folder) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Folder not found" },
      });
    }
  }
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
    const { title, archived, folderId, pinned } = req.body;
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

    // IDOR guard for folder move
    if (folderId) {
      const folder = await prisma.folder.findFirst({
        where: { id: folderId, userId: req.user!.id },
      });
      if (!folder) {
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Folder not found" },
        });
      }
    }
    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        title: title ?? conversation.title,
        folderId: folderId !== undefined ? folderId : conversation.folderId,
        pinned: pinned ?? conversation.pinned,
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

const tuningSchema = z.object({
  customPrompt: z.string().max(2000).nullable().optional(),
  customPromptEnabled: z.boolean().optional(),
});

router.get("/:id/tuning", requireAuth, async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id, deletedAt: null },
    select: { id: true, customPrompt: true, customPromptEnabled: true },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
  }
  return res.json({ success: true, data: { tuning: conversation } });
});

router.patch("/:id/tuning", requireAuth, validateBody(tuningSchema), async (req, res) => {
  const { customPrompt, customPromptEnabled } = req.body as {
    customPrompt?: string | null;
    customPromptEnabled?: boolean;
  };
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id, deletedAt: null },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
  }
  const nextPromptRaw = customPrompt !== undefined ? customPrompt : (conversation as unknown as { customPrompt?: string | null }).customPrompt ?? null;
  const nextEnabled = customPromptEnabled !== undefined ? customPromptEnabled : (conversation as unknown as { customPromptEnabled?: boolean }).customPromptEnabled ?? false;
  const sanitized = nextPromptRaw == null ? null : sanitizeTuningPrompt(nextPromptRaw);
  // Empty prompt cannot stay enabled
  const enabledFinal = !sanitized ? false : nextEnabled;
  if (sanitized !== null && sanitized.length > TUNING_MAX_LENGTH) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: `custom_prompt exceeds ${TUNING_MAX_LENGTH} characters` } });
  }
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      customPrompt: sanitized,
      customPromptEnabled: enabledFinal,
    },
    select: { id: true, customPrompt: true, customPromptEnabled: true },
  });
  return res.json({ success: true, data: { tuning: updated }, message: "Tuning updated" });
});

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
