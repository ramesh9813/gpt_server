import { NextFunction, Request, Response } from "express";

const safeMethods = ["GET", "HEAD", "OPTIONS"];
const csrfBypass = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/refresh",
  "/api/auth/google"
]);

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

  const csrfCookie = req.cookies?.csrfToken;
  const csrfHeader = req.get("x-csrf-token");

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    return res.status(403).json({
      success: false,
      error: { code: "CSRF", message: "Invalid CSRF token" }
    });
  }

  return next();
};
