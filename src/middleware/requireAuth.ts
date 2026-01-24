import { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/auth";

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const token = req.cookies?.accessToken;
  if (!token) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Missing access token" }
    });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Invalid access token" }
    });
  }
};