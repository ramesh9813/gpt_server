import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

const settingsSchema = z.object({
  theme: z.enum(["SYSTEM", "DARK", "LIGHT"]).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a hex color")
    .optional(),
  fontScale: z.enum(["SMALL", "DEFAULT", "LARGE"]).optional()
});

router.get("/", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      lastLoginAt: true
    }
  });

  return res.json({ success: true, data: { user } });
});

router.get("/settings", requireAuth, async (req, res) => {
  const settings = await prisma.userSettings.findUnique({
    where: { userId: req.user!.id }
  });

  return res.json({ success: true, data: { settings } });
});

router.patch(
  "/settings",
  requireAuth,
  validateBody(settingsSchema),
  async (req, res) => {
    const settings = await prisma.userSettings.update({
      where: { userId: req.user!.id },
      data: req.body
    });

    return res.json({
      success: true,
      data: { settings },
      message: "Settings updated"
    });
  }
);

router.get("/usage", requireAuth, async (req, res) => {
  const range = (req.query.range as string) || "day";
  const now = new Date();
  let start: Date | null = new Date(now);

  if (range === "week") {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
  } else if (range === "year") {
    start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  } else if (range === "all") {
    start = null;
  } else {
    start.setHours(0, 0, 0, 0);
  }

  const logs = await prisma.message.findMany({
    where: {
      conversation: { userId: req.user!.id },
      role: "ASSISTANT",
      ...(start ? { createdAt: { gte: start } } : {}),
      tokenCount: { not: null }
    },
    select: {
      id: true,
      createdAt: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      tokenCount: true
    },
    orderBy: { createdAt: "desc" }
  });

  return res.json({ success: true, data: { items: logs } });
});

export default router;
