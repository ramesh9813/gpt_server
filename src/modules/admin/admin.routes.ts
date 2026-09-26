import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { effectiveRole, emailPinnedRole, type UserRole } from "../../lib/userRoles";

const router = Router();

// Owner-only console: list users and promote/demote between "user" (general)
// and "admin". The owner role itself is env-pinned (OWNER_EMAILS) and can
// never be granted or revoked through this API.
const requireOwner = (req: any, res: any, next: any) => {
  if (req.user?.role !== "owner") {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Owner access required." },
    });
  }
  return next();
};

router.get("/users", requireAuth, requireOwner, async (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const users = await prisma.user.findMany({
    where: search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
  return res.json({
    success: true,
    data: {
      users: users.map((u) => ({
        ...u,
        // Show the EFFECTIVE role so env-pinned owner/admin read correctly
        // even before their DB row was synced at login.
        role: effectiveRole(u.email, u.role),
      })),
    },
  });
});

const setRoleSchema = z.object({ role: z.enum(["user", "admin"]) });

router.patch(
  "/users/:id",
  requireAuth,
  requireOwner,
  validateBody(setRoleSchema),
  async (req, res) => {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, name: true, role: true },
    });
    if (!target) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "User not found" },
      });
    }
    if (emailPinnedRole(target.email)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "ROLE_PINNED",
          message:
            "This account's role is pinned by server configuration (OWNER_EMAILS / ADMIN_EMAILS) and can't be changed here.",
        },
      });
    }
    if (target.id === req.user!.id) {
      return res.status(400).json({
        success: false,
        error: { code: "SELF_CHANGE", message: "You can't change your own role." },
      });
    }
    const nextRole = req.body.role as UserRole;
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: nextRole },
      select: { id: true, email: true, name: true, role: true },
    });
    return res.json({ success: true, data: { user: updated } });
  }
);

export default router;
