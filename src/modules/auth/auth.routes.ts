import { Response, Router } from "express";
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

const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string,
  csrfToken: string
) => {
  const secure = process.env.NODE_ENV === "production";
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 15 * 60 * 1000
  });
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
  res.cookie("csrfToken", csrfToken, {
    httpOnly: false,
    sameSite: "lax",
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
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
        role: "user",
        settings: {
          create: {}
        }
      }
    });

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role });
    const csrfToken = createCsrfToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(res, accessToken, refreshToken, csrfToken);

    return res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
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

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role });
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

    setAuthCookies(res, accessToken, refreshToken, csrfToken);

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
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
        role: "user",
        settings: {
          create: {}
        }
      }
    });

    await prisma.userSettings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id }
    });

    const accessToken = signAccessToken({ sub: user.id, role: user.role });
    const refreshToken = signRefreshToken({ sub: user.id, role: user.role });
    const csrfToken = createCsrfToken();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(res, accessToken, refreshToken, csrfToken);

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
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

  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  res.clearCookie("csrfToken");

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

    const accessToken = signAccessToken({ sub: payload.sub, role: payload.role });
    const newRefreshToken = signRefreshToken({
      sub: payload.sub,
      role: payload.role
    });
    const csrfToken = req.cookies?.csrfToken || createCsrfToken();

    await prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: hashToken(newRefreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    setAuthCookies(res, accessToken, newRefreshToken, csrfToken);

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
