import crypto from "crypto";
import type { CookieOptions, NextFunction, Request, Response } from "express";

const safeMethods = ["GET", "HEAD", "OPTIONS"];
// Only truly unauthenticated endpoints skip CSRF. /api/auth/refresh is
// intentionally NOT bypassed — when a csrf cookie exists it must be validated.
const csrfBypass = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/google",
]);

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const createCsrfToken = (): string => crypto.randomBytes(32).toString("hex");

// Same cookie shape the auth controller uses (cross-site deployment:
// SameSite=None + Secure + partitioned; lax in local http).
const csrfCookieOptions = (req: Request): CookieOptions => {
  const secure =
    req.secure ||
    String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
  const options: CookieOptions = {
    httpOnly: false,
    sameSite: secure ? "none" : "lax",
    secure,
    maxAge: 365 * 24 * 60 * 60 * 1000,
    path: "/",
  };
  if (secure) (options as Record<string, unknown>).partitioned = true;
  return options;
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

  // Bearer-authenticated request with no CSRF cookie at all (blocked or
  // never set): there is nothing to double-submit against, and the custom
  // header cannot be forged cross-site without a CORS preflight anyway.
  if (hasBearer && !csrfCookie) {
    return next();
  }

  // The readable CSRF cookie can be dropped by browser privacy settings while
  // the httpOnly refresh cookie still flows. The client keeps a JSON copy of
  // the same token and sends it as a custom header. A custom header cannot be
  // forged cross-site without a successful CORS preflight, so accept the
  // header-only fallback for session refresh/logout.
  const headerOnlyAllowed =
    req.path === "/api/auth/refresh" || req.path === "/api/auth/logout";
  if (!csrfCookie && csrfHeader && headerOnlyAllowed) {
    return next();
  }

  if (!csrfCookie || !csrfHeader || !timingSafeEqual(csrfCookie, csrfHeader)) {
    if (csrfCookie) {
      // A cookie EXISTS but the header copy drifted (stale tab). Never
      // rotate here: the client re-reads the readable cookie (its lookup is
      // cookie-first) and retries with the matching pair. Rotating would
      // desync clients whose browser rejects Set-Cookie.
      return res.status(403).json({
        success: false,
        error: { code: "CSRF", message: "Invalid CSRF token" },
      });
    }
    // No cookie at all (dropped/cleared): mint one, set it and return it in
    // the body — the client adopts it and its retry carries a matching pair.
    const fresh = createCsrfToken();
    try {
      res.cookie("csrfToken", fresh, csrfCookieOptions(req));
    } catch {
      // cookie best-effort; the body copy still lets the client recover
    }
    return res.status(403).json({
      success: false,
      error: { code: "CSRF", message: "Invalid CSRF token", csrfToken: fresh },
    });
  }

  return next();
};
