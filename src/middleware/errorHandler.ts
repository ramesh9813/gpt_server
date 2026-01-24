import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.flatten()
      }
    });
  }

  logger.error({ err }, "Unhandled error");
  const isDev = process.env.NODE_ENV !== "production";
  return res.status(500).json({
    success: false,
    error: {
      code: "SERVER_ERROR",
      message: "Something went wrong",
      details: isDev ? (err as Error)?.message : undefined
    }
  });
};
