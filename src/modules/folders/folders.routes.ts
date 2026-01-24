import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

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
