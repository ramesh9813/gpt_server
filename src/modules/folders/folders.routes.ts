import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { legacyMirrorOf, normalizePromptList, promptsFromRow, type TuningPromptItem } from "../../lib/tuning";

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(50)
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  pinned: z.boolean().optional()
});

router.get("/", requireAuth, async (req, res) => {
  const folders = await prisma.folder.findMany({
    where: {
      userId: req.user!.id
    },
    include: {
      _count: {
        select: { conversations: { where: { deletedAt: null } } }
      }
    },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }]
  });

  return res.json({
    success: true,
    data: { items: folders }
  });
});

router.post("/", requireAuth, validateBody(createSchema), async (req, res) => {
  const folder = await prisma.folder.create({
    data: {
      userId: req.user!.id,
      name: req.body.name
    }
  });

  return res.status(201).json({
    success: true,
    data: { folder },
    message: "Folder created"
  });
});

router.patch("/:id", requireAuth, validateBody(updateSchema), async (req, res) => {
  const folder = await prisma.folder.findFirst({
    where: {
      id: req.params.id,
      userId: req.user!.id
    }
  });

  if (!folder) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Folder not found" }
    });
  }

  const updated = await prisma.folder.update({
    where: { id: folder.id },
    data: {
      name: req.body.name ?? folder.name,
      pinned: req.body.pinned ?? folder.pinned
    }
  });

  return res.json({
    success: true,
    data: { folder: updated },
    message: "Folder updated"
  });
});

const tuningItemSchema = z.object({
  id: z.string().max(64).optional(),
  text: z.string().max(2000),
  enabled: z.boolean().optional(),
});

const tuningSchema = z.object({
  customPrompt: z.string().max(2000).nullable().optional(),
  customPromptEnabled: z.boolean().optional(),
  customPrompts: z.array(tuningItemSchema).max(20).optional(),
});

const toFolderTuningResponse = (row: { id: string } & Record<string, unknown>) => {
  const customPrompts = promptsFromRow(row);
  const mirror = legacyMirrorOf(customPrompts);
  return {
    id: row.id,
    customPrompts,
    customPrompt: mirror.customPrompt,
    customPromptEnabled: mirror.customPromptEnabled,
  };
};

// Folder-level custom prompts: inherited at read time by every chat inside
// the folder (no duplication — edits apply to all chats instantly).
router.get("/:id/tuning", requireAuth, async (req, res) => {
  const folder = await prisma.folder.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true, customPrompt: true, customPromptEnabled: true, customPrompts: true },
  });
  if (!folder) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Folder not found" } });
  }
  return res.json({ success: true, data: { tuning: toFolderTuningResponse(folder) } });
});

router.patch("/:id/tuning", requireAuth, validateBody(tuningSchema), async (req, res) => {
  const { customPrompt, customPromptEnabled, customPrompts } = req.body as {
    customPrompt?: string | null;
    customPromptEnabled?: boolean;
    customPrompts?: Array<{ id?: string; text: string; enabled?: boolean }>;
  };
  const folder = await prisma.folder.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!folder) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Folder not found" } });
  }
  let items: TuningPromptItem[];
  if (customPrompts !== undefined) {
    items = normalizePromptList(customPrompts);
  } else {
    const f = folder as unknown as { customPrompts?: unknown; customPrompt?: string | null; customPromptEnabled?: boolean };
    items = normalizePromptList(f.customPrompts, customPrompt !== undefined ? customPrompt : f.customPrompt, customPromptEnabled !== undefined ? customPromptEnabled : f.customPromptEnabled);
    if (customPrompt !== undefined || customPromptEnabled !== undefined) {
      const keepId = items[0]?.id ?? "";
      const single = normalizePromptList(null, customPrompt !== undefined ? customPrompt : f.customPrompt, customPromptEnabled !== undefined ? customPromptEnabled : f.customPromptEnabled);
      items = single.map((s) => ({ ...s, id: keepId || s.id }));
    }
  }
  const mirror = legacyMirrorOf(items);
  const updated = await prisma.folder.update({
    where: { id: folder.id },
    data: {
      customPrompts: items,
      customPrompt: mirror.customPrompt,
      customPromptEnabled: mirror.customPromptEnabled,
    },
    select: { id: true, customPrompt: true, customPromptEnabled: true, customPrompts: true },
  });
  return res.json({ success: true, data: { tuning: toFolderTuningResponse(updated) }, message: "Folder tuning updated" });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const folder = await prisma.folder.findFirst({
    where: {
      id: req.params.id,
      userId: req.user!.id
    }
  });

  if (!folder) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Folder not found" }
    });
  }

  // Set folderId to null for all conversations in this folder
  await prisma.conversation.updateMany({
    where: { folderId: folder.id },
    data: { folderId: null }
  });

  await prisma.folder.delete({
    where: { id: folder.id }
  });

  return res.json({ success: true, data: {}, message: "Folder deleted" });
});

export default router;
