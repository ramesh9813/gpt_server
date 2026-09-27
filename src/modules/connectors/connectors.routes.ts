import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../../lib/prisma";
import { requireAuth } from "../../middleware/requireAuth";
import { verifyAccessToken } from "../../lib/auth";
import { normalizeUserRole } from "../../lib/userRoles";
import { env } from "../../lib/config";
import { isConnectorProvider } from "./tokenStore";
import {
  canvaAuthorizeHandler,
  canvaCallbackHandler,
  canvaDisconnectHandler,
} from "./canva/canvaOAuth";
import { getCachedToolNames } from "./canva/canvaMcp";

const router = Router();

// Brute-force guard on the OAuth handshake (login-CSRF / code replay).
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

// Template routes are generic (:provider) so future connectors slot in;
// only "canva" is served today.
const requireProvider = (req: Request, res: Response, next: NextFunction) => {
  if (!isConnectorProvider(req.params.provider)) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Unknown connector provider" },
    });
  }
  return next();
};

// Top-level navigation authorize: relies on httpOnly cookies (and optionally
// Authorization header for SPA-initiated navigations). Tokens in query strings
// are never accepted — they leak via Referer, logs and history.
const requireAuthForAuthorize = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const bearerToken =
    authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token = bearerToken || req.cookies?.accessToken;

  const loginRedirect = () => {
    const origin = env.APP_ORIGIN.split(",")[0]?.trim().replace(/\/+$/, "") || "";
    return res.redirect(302, `${origin}/login?next=/account?connector=canva`);
  };

  if (!token) return loginRedirect();
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: normalizeUserRole(payload.role) };
    return next();
  } catch {
    return loginRedirect();
  }
};

router.get("/:provider/authorize", oauthLimiter, requireAuthForAuthorize, requireProvider, (req, res) =>
  canvaAuthorizeHandler(req, res)
);

// Public: Canva redirects the user's browser here. The user is resolved
// from the single-use state row, never from a session.
router.get("/:provider/callback", oauthLimiter, requireProvider, (req, res) =>
  canvaCallbackHandler(req, res)
);

router.post("/:provider/disconnect", oauthLimiter, requireAuth, requireProvider, (req, res) =>
  canvaDisconnectHandler(req, res)
);

// Never returns tokens, secrets, or MCP URLs — booleans + tool names only.
router.get("/status", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const row = await prisma.connectorToken.findUnique({
    where: { userId_provider: { userId, provider: "canva" } },
  });
  return res.json({
    success: true,
    data: {
      providers: [
        {
          provider: "canva",
          connected: !!row,
          tools: row ? getCachedToolNames(userId) : [],
        },
      ],
    },
  });
});

export default router;
