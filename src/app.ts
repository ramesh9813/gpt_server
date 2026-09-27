import cors from "cors";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { env } from "./lib/config";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/errorHandler";
import { csrfProtect } from "./middleware/csrf";
import authRoutes from "./modules/auth/auth.routes";
import userRoutes from "./modules/users/users.routes";
import conversationRoutes from "./modules/conversations/conversations.routes";
import folderRoutes from "./modules/folders/folders.routes";
import messageRoutes from "./modules/messages/messages.routes";
import chatRoutes from "./modules/chat/chat.routes";
import modelRoutes from "./modules/models/models.routes";
import runnerRoutes from "./modules/runner/runner.routes";
import connectorRoutes from "./modules/connectors/connectors.routes";
import byokRoutes from "./modules/byok/byok.routes";
import adminRoutes from "./modules/admin/admin.routes";

const app = express();

app.set("trust proxy", 1);

// Redact secrets from structured logs (pino-http).
app.use(
  pinoHttp({
    logger: logger as any,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-byok-key']",
        "req.headers['x-csrf-token']",
      ],
      remove: true,
    },
  } as any)
);
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginEmbedderPolicy: false,
    // HSTS only over HTTPS (helmet handles it internally).
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://api.openrouter.ai", "https://openrouter.ai"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
const allowedOrigins = env.APP_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const isDev = process.env.NODE_ENV !== "production";
app.use(
  cors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        return callback(null, true);
      }
      const normalizedOrigin = origin.replace(/\/+$/, "");
      const isAllowed = allowedOrigins.includes(normalizedOrigin);
      const isLocalhost =
        isDev &&
        /^https?:\/\/(?:localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (isAllowed || isLocalhost) {
        return callback(null, true);
      }
      logger.warn({ origin }, "CORS rejected origin");
      return callback(null, false);
    },
    credentials: true
  })
);
// 10mb: allow inline base64 vision images (up to 3x ~7MB strings, total capped here).
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(csrfProtect);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const runnerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const byokLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
const modelsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/", (_req, res) => {
  res.json({ success: true, message: "ChatGPT API Server is running" });
});

app.get("/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/me", globalLimiter, userRoutes);
app.use("/api/folders", globalLimiter, folderRoutes);
app.use("/api/conversations", globalLimiter, conversationRoutes);
app.use("/api/conversations", globalLimiter, messageRoutes);
app.use("/api/chat", chatLimiter, chatRoutes);
app.use("/api/models", modelsLimiter, modelRoutes);
app.use("/api/runner", runnerLimiter, runnerRoutes);
app.use("/api/connectors", globalLimiter, connectorRoutes);
app.use("/api/byok", byokLimiter, byokRoutes);
app.use("/api/admin", adminLimiter, adminRoutes);

app.use(errorHandler);

export default app;
