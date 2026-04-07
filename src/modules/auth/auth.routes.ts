import { CookieOptions, Request, Response, Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { firebaseAdmin } from "../../lib/firebaseAdmin";
import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  hashToken,
  verifyRefreshToken
} from "../../lib/auth";
import { normalizeUserRole } from "../../lib/userRoles";
import { validateBody } from "../../middleware/validate";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().min(1).max(80).optional()
  )
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const getBearerToken = (authorization?: string) => {
  if (!authorization) return null;
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
};

const createCsrfToken = () => crypto.randomBytes(24).toString("hex");

const shouldUseSecureCookies = (req: Request) => {
  if (process.env.NODE_ENV === "production") {
    return true;
  }

  const forwardedProto = req.get("x-forwarded-proto");
  if (forwardedProto?.split(",")[0]?.trim() === "https") {
    return true;
  }

  const requestOrigin = req.get("origin");
  if (requestOrigin?.startsWith("https://")) {
    return true;
  }

  return (process.env.RENDER_EXTERNAL_URL || "").startsWith("https://");
};

const buildCookieOptions = (
  req: Request,
  maxAge: number,
  httpOnly: boolean
): CookieOptions => {
  const secure = shouldUseSecureCookies(req);

  return {
    httpOnly,
    sameSite: secure ? "none" : "lax",
    secure,
    maxAge,
    path: "/"
  };
};

const setAuthCookies = (
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
  csrfToken: string
) => {
  res.cookie(
    "accessToken",
    accessToken,
    buildCookieOptions(req, 15 * 60 * 1000, true)
  );
  res.cookie(
    "refreshToken",
    refreshToken,
    buildCookieOptions(req, 30 * 24 * 60 * 60 * 1000, true)
  );
  res.cookie(
    "csrfToken",
    csrfToken,
    buildCookieOptions(req, 30 * 24 * 60 * 60 * 1000, false)
  );
};

const clearAuthCookies = (req: Request, res: Response) => {
  const secure = shouldUseSecureCookies(req);
  const base = {
    sameSite: secure ? "none" : "lax",
    secure,
    path: "/"
  } as const;

  res.clearCookie("accessToken", { ...base, httpOnly: true });
  res.clearCookie("refreshToken", { ...base, httpOnly: true });
  res.clearCookie("csrfToken", { ...base, httpOnly: false });
};

router.post("/signup", validateBody(signupSchema), async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: "EMAIL_EXISTS", message: "Email already in use" }
      });
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        settings: {
          create: {}
        }
      }
    });
    const normalizedRole = normalizeUserRole(user.role);

    const accessToken = signAccessToken({ sub: user.id, role: normalizedRole });
    const refreshToken = signRefreshToken({ sub: user.id, role: normalizedRole });
    const csrfToken = createCsrfToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(req, res, accessToken, refreshToken, csrfToken);

    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: normalizedRole
        }
      },
      message: "Signup successful"
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/login", validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" }
      });
    }

    const match = await verifyPassword(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" }
      });
    }
    const normalizedRole = normalizeUserRole(user.role);

    const accessToken = signAccessToken({ sub: user.id, role: normalizedRole });
    const refreshToken = signRefreshToken({ sub: user.id, role: normalizedRole });
    const csrfToken = createCsrfToken();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    setAuthCookies(req, res, accessToken, refreshToken, csrfToken);

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: normalizedRole
        }
      },
      message: "Login successful"
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/google", async (req, res, next) => {
  try {
    const token = getBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing Google token" }
      });
    }

    let decoded: any;
    try {
      decoded = await firebaseAdmin.auth().verifyIdToken(token);
    } catch (err: any) {
      return res.status(401).json({
        success: false,
        error: {
          code: "INVALID_GOOGLE_TOKEN",
          message: "Invalid or expired Google token",
          details: err?.message
        }
      });
    }

    if (!decoded.email) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_TOKEN", message: "Google token missing email" }
      });
    }

    const email = decoded.email.toLowerCase();
    const randomPassword = crypto.randomBytes(32).toString("hex");
    const passwordHash = await hashPassword(randomPassword);

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        lastLoginAt: new Date(),
        name: decoded.name || undefined
      },
      create: {
        email,
        passwordHash,
        name: decoded.name || null,
        settings: {
          create: {}
        }
      }
    });
    const normalizedRole = normalizeUserRole(user.role);

    await prisma.userSettings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id }
    });

    const accessToken = signAccessToken({ sub: user.id, role: normalizedRole });
    const refreshToken = signRefreshToken({ sub: user.id, role: normalizedRole });
    const csrfToken = createCsrfToken();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(req, res, accessToken, refreshToken, csrfToken);

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: normalizedRole
        }
      },
      message: "Google login successful"
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  clearAuthCookies(req, res);

  return res.json({ success: true, data: {}, message: "Logged out" });
});

router.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing refresh token" }
    });
  }

  try {
    const payload = verifyRefreshToken(refreshToken);
    const normalizedRole = normalizeUserRole(payload.role);
    const stored = await prisma.refreshToken.findFirst({
      where: {
        tokenHash: hashToken(refreshToken),
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (!stored) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Refresh token revoked" }
      });
    }

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() }
    });

    const accessToken = signAccessToken({ sub: payload.sub, role: normalizedRole });
    const newRefreshToken = signRefreshToken({
      sub: payload.sub,
      role: normalizedRole
    });
    const csrfToken = req.cookies?.csrfToken || createCsrfToken();

    await prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: hashToken(newRefreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(req, res, accessToken, newRefreshToken, csrfToken);

    return res.json({
      success: true,
      data: { accessTokenExpiresIn: 900 },
      message: "Refreshed"
    });
  } catch {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Invalid refresh token" }
    });
  }
});

export default router;
