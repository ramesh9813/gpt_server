import { Router, Request } from "express";
import { getCatalogMeta, listOpenRouterModels } from "../../lib/openrouter";
import { verifyAccessToken } from "../../lib/auth";
import { normalizeUserRole, UserRole } from "../../lib/userRoles";

const router = Router();

const resolveUserRole = (req: Request): UserRole => {
  if (req.user?.role) return req.user.role;
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
  const token = bearerToken || req.cookies?.accessToken;
  if (!token) return "user";
  try {
    const payload = verifyAccessToken(token);
    return normalizeUserRole(payload.role);
  } catch {
    return "user";
  }
};

router.get("/", async (req, res) => {
  try {
    // ?refresh=1 bypasses the 5-min server cache (force refetch from OpenRouter).
    const refresh =
      req.query.refresh === "1" || req.query.refresh === "true";
    // Show the full OpenRouter catalog to every role (deprecated models are filtered out).
    // Access control stays enforced at send time (resolveModelForRole in chat/stream returns
    // 403 MODEL_NOT_ALLOWED for disallowed models).
    const models = await listOpenRouterModels(refresh);
    const { source, fetchedAt } = getCatalogMeta();
    const role = resolveUserRole(req);

    return res.json({
      success: true,
      data: { models },
      meta: { role, total: models.length, source, fetchedAt }
    });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      error: {
        code: "OPENROUTER_ERROR",
        message: "Failed to fetch models",
        details: err?.message || "Unknown error"
      }
    });
  }
});

export default router;
