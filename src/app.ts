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

const app = express();

app.use(pinoHttp({ logger: logger as any }));
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" }
  })
);
const allowedOrigins = env.APP_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isDev = process.env.NODE_ENV !== "production";

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      const isAllowed = allowedOrigins.includes(origin);
      const isLocalhost =
        isDev && /^https?:\/\/localhost:\d+$/.test(origin);
      if (isAllowed || isLocalhost) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(csrfProtect);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30
});
const runnerLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, data: { status: "ok" } });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/me", userRoutes);
app.use("/api/folders", folderRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/conversations", messageRoutes);
app.use("/api/chat", chatLimiter, chatRoutes);
app.use("/api/models", modelRoutes);
app.use("/api/runner", runnerLimiter, runnerRoutes);

app.use(errorHandler);

export default app;
