import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { legacyMirrorOf, mutedIdsFromRow, normalizePromptList, promptsFromRow, sanitizeTuningPrompt, TUNING_MAX_LENGTH, type TuningPromptItem } from "../../lib/tuning";

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

  // Garbage-collect message-less conversations older than a day: creating a
  // chat and walking away without typing must not pile empty rows into
  // history. Best-effort — list failures must never come from cleanup.
  try {
    await prisma.conversation.deleteMany({
      where: {
        userId: req.user!.id,
        deletedAt: null,
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        messages: { none: {} },
      },
    });
  } catch {
    // ignore — history still lists
  }

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
      include: { _count: { select: { messages: true } } },
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

const tuningItemSchema = z.object({
  id: z.string().max(64).optional(),
  text: z.string().max(2000),
  enabled: z.boolean().optional(),
});

const tuningSchema = z.object({
  customPrompt: z.string().max(2000).nullable().optional(),
  customPromptEnabled: z.boolean().optional(),
  customPrompts: z.array(tuningItemSchema).max(20).optional(),
  mutedFolderPromptIds: z.array(z.string().max(64)).max(20).optional(),
});

const toTuningResponse = (row: { id: string } & Record<string, unknown>) => {
  const customPrompts = promptsFromRow(row);
  const mirror = legacyMirrorOf(customPrompts);
  return {
    id: row.id,
    customPrompts,
    mutedFolderPromptIds: mutedIdsFromRow(row),
    customPrompt: mirror.customPrompt,
    customPromptEnabled: mirror.customPromptEnabled,
  };
};

router.get("/:id/tuning", requireAuth, async (req, res) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id, deletedAt: null },
    select: { id: true, customPrompt: true, customPromptEnabled: true, customPrompts: true, mutedFolderPromptIds: true },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
  }
  return res.json({ success: true, data: { tuning: toTuningResponse(conversation) } });
});

router.patch("/:id/tuning", requireAuth, validateBody(tuningSchema), async (req, res) => {
  const { customPrompt, customPromptEnabled, customPrompts, mutedFolderPromptIds } = req.body as {
    customPrompt?: string | null;
    customPromptEnabled?: boolean;
    customPrompts?: Array<{ id?: string; text: string; enabled?: boolean }>;
    mutedFolderPromptIds?: string[];
  };
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id, deletedAt: null },
  });
  if (!conversation) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Conversation not found" } });
  }
  // List form wins when present; otherwise the legacy single prompt maps to
  // a one-item list so old clients keep working unchanged.
  let items: TuningPromptItem[];
  if (customPrompts !== undefined) {
    items = normalizePromptList(customPrompts);
  } else {
    const nextPromptRaw = customPrompt !== undefined ? customPrompt : (conversation as unknown as { customPrompt?: string | null }).customPrompt ?? null;
    const nextEnabled = customPromptEnabled !== undefined ? customPromptEnabled : (conversation as unknown as { customPromptEnabled?: boolean }).customPromptEnabled ?? true;
    items = normalizePromptList(
      (conversation as unknown as { customPrompts?: unknown }).customPrompts,
      nextPromptRaw,
      nextEnabled
    );
    // Legacy-only write replaces the whole list (old clients own one prompt).
    if (customPrompt !== undefined || customPromptEnabled !== undefined) {
      const sanitized = nextPromptRaw == null ? null : sanitizeTuningPrompt(nextPromptRaw);
      items = sanitized ? [{ id: items[0]?.id ?? "", text: sanitized, enabled: sanitized ? nextEnabled : false }] : [];
      if (items.length > 0 && !items[0].id) items[0].id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
  }
  const mirror = legacyMirrorOf(items);
  const muted = Array.isArray(mutedFolderPromptIds)
    ? mutedFolderPromptIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 20)
    : undefined;
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      customPrompts: items,
      ...(muted !== undefined ? { mutedFolderPromptIds: muted } : {}),
      customPrompt: mirror.customPrompt,
      customPromptEnabled: mirror.customPromptEnabled,
    },
    select: { id: true, customPrompt: true, customPromptEnabled: true, customPrompts: true, mutedFolderPromptIds: true },
  });
  return res.json({ success: true, data: { tuning: toTuningResponse(updated) }, message: "Tuning updated" });
})

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
