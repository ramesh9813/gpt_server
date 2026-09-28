import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { sanitizeTuningPrompt, TUNING_MAX_LENGTH } from "../../lib/tuning";

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(50)
});

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional()
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
    orderBy: { createdAt: "desc" }
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
      name: req.body.name ?? folder.name
    }
  });

  return res.json({
    success: true,
    data: { folder: updated },
    message: "Folder updated"
  });
});

const tuningSchema = z.object({
  customPrompt: z.string().max(2000).nullable().optional(),
  customPromptEnabled: z.boolean().optional(),
});

// Folder-level custom prompt: inherited at read time by every chat inside
// the folder (no duplication — edits apply to all chats instantly).
router.get("/:id/tuning", requireAuth, async (req, res) => {
  const folder = await prisma.folder.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    select: { id: true, customPrompt: true, customPromptEnabled: true },
  });
  if (!folder) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Folder not found" } });
  }
  return res.json({ success: true, data: { tuning: folder } });
});

router.patch("/:id/tuning", requireAuth, validateBody(tuningSchema), async (req, res) => {
  const { customPrompt, customPromptEnabled } = req.body as {
    customPrompt?: string | null;
    customPromptEnabled?: boolean;
  };
  const folder = await prisma.folder.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
  });
  if (!folder) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Folder not found" } });
  }
  const nextPromptRaw = customPrompt !== undefined ? customPrompt : (folder as unknown as { customPrompt?: string | null }).customPrompt ?? null;
  const nextEnabled = customPromptEnabled !== undefined ? customPromptEnabled : (folder as unknown as { customPromptEnabled?: boolean }).customPromptEnabled ?? true;
  const sanitized = nextPromptRaw == null ? null : sanitizeTuningPrompt(nextPromptRaw);
  // Empty prompt cannot stay enabled
  const enabledFinal = !sanitized ? false : nextEnabled;
  if (sanitized !== null && sanitized.length > TUNING_MAX_LENGTH) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: `custom_prompt exceeds ${TUNING_MAX_LENGTH} characters` } });
  }
  const updated = await prisma.folder.update({
    where: { id: folder.id },
    data: {
      customPrompt: sanitized,
      customPromptEnabled: enabledFinal,
    },
    select: { id: true, customPrompt: true, customPromptEnabled: true },
  });
  return res.json({ success: true, data: { tuning: updated }, message: "Folder tuning updated" });
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
