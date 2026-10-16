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
import {
  googleAuthorizeHandler,
  googleCallbackHandler,
  googleDisconnectHandler,
} from "./google/googleOAuth";
import { getCachedToolNames } from "./canva/canvaMcp";
import { DRIVE_TOOL_NAMES } from "./google/googleDrive";

const router = Router();

// Brute-force guard on the OAuth handshake (login-CSRF / code replay).
const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
});

// Template routes are generic (:provider); "canva" and "google" are served.
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
    // next is encoded so /account?connector=<provider> survives as one param.
    const next = encodeURIComponent(`/account?connector=${req.params.provider}`);
    return res.redirect(302, `${origin}/login?next=${next}`);
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

const providerHandlers = {
  canva: {
    authorize: canvaAuthorizeHandler,
    callback: canvaCallbackHandler,
    disconnect: canvaDisconnectHandler,
  },
  google: {
    authorize: googleAuthorizeHandler,
    callback: googleCallbackHandler,
    disconnect: googleDisconnectHandler,
  },
} as const;

router.get("/:provider/authorize", oauthLimiter, requireAuthForAuthorize, requireProvider, (req, res) => {
  const handlers = providerHandlers[req.params.provider as keyof typeof providerHandlers];
  if (!handlers) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Unknown connector provider" },
    });
  }
  return handlers.authorize(req, res);
});

// Public: the provider redirects the user's browser here. The user is resolved
// from the single-use state row, never from a session.
router.get("/:provider/callback", oauthLimiter, requireProvider, (req, res) => {
  const handlers = providerHandlers[req.params.provider as keyof typeof providerHandlers];
  if (!handlers) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Unknown connector provider" },
    });
  }
  return handlers.callback(req, res);
});

router.post("/:provider/disconnect", oauthLimiter, requireAuth, requireProvider, (req, res) => {
  const handlers = providerHandlers[req.params.provider as keyof typeof providerHandlers];
  if (!handlers) {
    return res.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Unknown connector provider" },
    });
  }
  return handlers.disconnect(req, res);
});

// Never returns tokens, secrets, or MCP URLs — booleans + tool names only.
router.get("/status", requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const [canvaRow, googleRow] = await Promise.all([
    prisma.connectorToken.findUnique({
      where: { userId_provider: { userId, provider: "canva" } },
    }),
    prisma.connectorToken.findUnique({
      where: { userId_provider: { userId, provider: "google" } },
    }),
  ]);
  return res.json({
    success: true,
    data: {
      providers: [
        {
          provider: "canva",
          connected: !!canvaRow,
          tools: canvaRow ? getCachedToolNames(userId) : [],
        },
        {
          provider: "google",
          connected: !!googleRow,
          tools: googleRow ? [...DRIVE_TOOL_NAMES] : [],
        },
      ],
    },
  });
});

export default router;
