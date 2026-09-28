import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { BYOK_PROVIDERS } from "../../lib/byok";
import {
  clearProviderCache,
  coerceKind,
  isValidProviderId,
  listAllByokProviders,
  rowToByokProvider,
} from "../../lib/providers";

const router = Router();

const requireAdminOrOwner = (req: any, res: any, next: any) => {
  if (req.user?.role !== "owner" && req.user?.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Admin or owner access required." },
    });
  }
  return next();
};

const isHttpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

const providerSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(32)
    .refine((v) => isValidProviderId(v.trim().toLowerCase()), {
      message: "id must be 2-32 chars: lowercase letters, digits, - or _ (e.g. my-provider)",
    }),
  name: z.string().min(1).max(80),
  baseUrl: z.string().min(8).max(300).refine((v) => isHttpsUrl(v.trim()), { message: "baseUrl must be a valid http(s) URL" }),
  kind: z.enum(["openai", "gemini", "anthropic"]).default("openai"),
  keyHint: z.string().max(80).optional(),
  keyPattern: z.string().max(300).optional(),
  keylessModels: z.boolean().optional(),
  models: z.array(z.string().min(1).max(120)).max(200).optional(),
  streamUsage: z.boolean().optional(),
  allModelsFree: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  baseUrl: z.string().min(8).max(300).optional().refine((v) => !v || isHttpsUrl(v.trim()), { message: "baseUrl must be a valid http(s) URL" }),
  kind: z.enum(["openai", "gemini", "anthropic"]).optional(),
  keyHint: z.string().max(80).optional(),
  keyPattern: z.string().max(300).nullable().optional(),
  keylessModels: z.boolean().optional(),
  models: z.array(z.string().min(1).max(120)).max(200).nullable().optional(),
  streamUsage: z.boolean().optional(),
  allModelsFree: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const sanitizeProvider = (row: any) => ({
  id: row.id,
  name: row.name,
  baseUrl: row.baseUrl,
  kind: coerceKind(row.kind) ?? "openai",
  keyHint: row.keyHint ?? "your API key",
  keyPattern: row.keyPattern ?? null,
  keylessModels: Boolean(row.keylessModels),
  models: Array.isArray(row.models) ? row.models : [],
  streamUsage: Boolean(row.streamUsage),
  allModelsFree: Boolean(row.allModelsFree),
  isActive: Boolean(row.isActive),
  createdBy: row.createdBy ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Public: every signed-in user sees active providers (static + dynamic).
router.get("/", requireAuth, async (_req, res) => {
  const all = await listAllByokProviders();
  return res.json({
    success: true,
    data: {
      providers: all.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl,
        keyHint: p.keyHint,
        keyPattern: p.keyPattern.source,
        keylessModels: p.keylessModels,
        models: p.models,
        streamUsage: Boolean(p.streamUsage),
        allModelsFree: Boolean(p.allModelsFree),
        source: (BYOK_PROVIDERS as any)[p.id] ? "builtin" : "custom",
      })),
    },
  });
});

// Admin view: includes inactive + raw rows
router.get("/admin", requireAuth, requireAdminOrOwner, async (_req, res) => {
  try {
    const rows = await (prisma as any).provider.findMany({ orderBy: { createdAt: "asc" } });
    return res.json({ success: true, data: { providers: rows.map(sanitizeProvider) } });
  } catch {
    return res.json({ success: true, data: { providers: [] } });
  }
});

router.post("/", requireAuth, requireAdminOrOwner, validateBody(providerSchema), async (req, res) => {
  const body = req.body as z.infer<typeof providerSchema>;
  const id = body.id.trim().toLowerCase();
  if ((BYOK_PROVIDERS as any)[id]) {
    return res.status(409).json({
      success: false,
      error: { code: "ID_TAKEN", message: `Provider id "${id}" is already reserved by a built-in provider.` },
    });
  }
  if (body.keyPattern && body.keyPattern.trim()) {
    try {
      new RegExp(body.keyPattern.trim());
    } catch {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PATTERN", message: "keyPattern is not a valid regular expression." },
      });
    }
  }
  const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
  try {
    const row = await (prisma as any).provider.create({
      data: {
        id,
        name: body.name.trim(),
        baseUrl,
        kind: body.kind ?? "openai",
        keyHint: body.keyHint?.trim() || "your API key",
        keyPattern: body.keyPattern?.trim() || null,
        keylessModels: Boolean(body.keylessModels),
        models: body.models ?? [],
        streamUsage: Boolean(body.streamUsage),
        allModelsFree: Boolean(body.allModelsFree),
        isActive: body.isActive ?? true,
        createdBy: req.user!.id,
      },
    });
    clearProviderCache();
    return res.status(201).json({ success: true, data: { provider: sanitizeProvider(row) } });
  } catch (e: any) {
    if (String(e?.code) === "P2002") {
      return res.status(409).json({
        success: false,
        error: { code: "ID_TAKEN", message: `Provider id "${id}" already exists.` },
      });
    }
    throw e;
  }
});

router.patch("/:id", requireAuth, requireAdminOrOwner, validateBody(patchSchema), async (req, res) => {
  const id = String(req.params.id ?? "").trim().toLowerCase();
  const body = req.body as z.infer<typeof patchSchema>;
  const existing = await (prisma as any).provider.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Provider not found" } });
  }
  if (body.keyPattern !== undefined && body.keyPattern !== null && String(body.keyPattern).trim()) {
    try {
      new RegExp(String(body.keyPattern).trim());
    } catch {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PATTERN", message: "keyPattern is not a valid regular expression." },
      });
    }
  }
  if (body.baseUrl !== undefined && body.baseUrl !== null && String(body.baseUrl).trim() && !isHttpsUrl(String(body.baseUrl).trim())) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_URL", message: "baseUrl must be a valid http(s) URL" },
    });
  }
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.baseUrl !== undefined && body.baseUrl !== null) data.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, "");
  if (body.kind !== undefined) data.kind = body.kind;
  if (body.keyHint !== undefined) data.keyHint = body.keyHint?.trim() || "your API key";
  if (body.keyPattern !== undefined) data.keyPattern = body.keyPattern ? String(body.keyPattern).trim() : null;
  if (body.keylessModels !== undefined) data.keylessModels = Boolean(body.keylessModels);
  if (body.models !== undefined) data.models = body.models ?? [];
  if (body.streamUsage !== undefined) data.streamUsage = Boolean(body.streamUsage);
  if (body.allModelsFree !== undefined) data.allModelsFree = Boolean(body.allModelsFree);
  if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
  const row = await (prisma as any).provider.update({ where: { id }, data });
  clearProviderCache();
  return res.json({ success: true, data: { provider: sanitizeProvider(row) } });
});

router.delete("/:id", requireAuth, requireAdminOrOwner, async (req, res) => {
  const id = String(req.params.id ?? "").trim().toLowerCase();
  const existing = await (prisma as any).provider.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Provider not found" } });
  }
  await (prisma as any).provider.delete({ where: { id } });
  clearProviderCache();
  return res.json({ success: true, data: { deleted: id } });
});

// Back-compat: row shape usable as ByokProvider for /byok/* without reimporting byok
export const getCustomProviderById = async (id: string) => {
  const row = await (prisma as any).provider.findUnique({ where: { id: id.trim().toLowerCase() } });
  if (!row || !row.isActive) return null;
  return rowToByokProvider(row as any);
};

export default router;
