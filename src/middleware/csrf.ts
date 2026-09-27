import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

const safeMethods = ["GET", "HEAD", "OPTIONS"];
// Only truly unauthenticated endpoints skip CSRF. /api/auth/refresh is
// intentionally NOT bypassed — when a csrf cookie exists it must be validated.
const csrfBypass = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/google",
]);

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export const csrfProtect = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (safeMethods.includes(req.method)) {
    return next();
  }

  if (csrfBypass.has(req.path)) {
    return next();
  }

  // Pure stateless Bearer clients (no cookies at all) don't need CSRF.
  // Any request that carries cookies must present a valid double-submit token.
  const hasCookieAuth =
    Boolean(req.cookies?.accessToken) ||
    Boolean(req.cookies?.refreshToken) ||
    Boolean(req.cookies?.csrfToken);
  const authHeader = req.headers.authorization;
  const hasBearer = Boolean(authHeader && authHeader.startsWith("Bearer "));

  if (hasBearer && !hasCookieAuth) {
    return next();
  }

  const csrfCookie = req.cookies?.csrfToken;
  const csrfHeader = req.get("x-csrf-token");

  if (!csrfCookie || !csrfHeader || !timingSafeEqual(csrfCookie, csrfHeader)) {
    return res.status(403).json({
      success: false,
      error: { code: "CSRF", message: "Invalid CSRF token" }
    });
  }

  return next();
};
