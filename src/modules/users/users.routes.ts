import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { normalizeUserRole } from "../../lib/userRoles";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

const settingsSchema = z.object({
  theme: z.enum(["SYSTEM", "DARK", "LIGHT"]).optional(),
  fontScale: z.enum(["XSMALL", "SMALL", "DEFAULT", "LARGE", "XLARGE"]).optional(),
  brand: z
    .enum(["default", "chatgpt", "claude", "gemini", "grok", "deepseek"])
    .optional(),
  pinHeader: z.boolean().optional(),
  model: z.string().min(1).max(200).optional(),
  appFontSize: z.number().int().min(12).max(22).optional(),
  iconScale: z.number().min(0.8).max(1.6).optional()
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

  return res.json({
    success: true,
    data: {
      user: user
        ? {
            ...user,
            role: normalizeUserRole(user.role)
          }
        : null
    }
  });
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
    let settings;
    try {
      settings = await prisma.userSettings.update({
        where: { userId: req.user!.id },
        data: req.body
      });
    } catch (err: unknown) {
      // Tolerate DBs not yet pushed with appFontSize/iconScale columns:
      // retry without the new fields instead of failing the whole save.
      const code = (err as { code?: string })?.code;
      if ((code === "P2022" || code === "P2003") && req.body && typeof req.body === "object") {
        const { appFontSize: _a, iconScale: _i, ...rest } = req.body as Record<string, unknown>;
        settings = await prisma.userSettings.update({
          where: { userId: req.user!.id },
          data: rest
        });
      } else {
        throw err;
      }
    }

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
