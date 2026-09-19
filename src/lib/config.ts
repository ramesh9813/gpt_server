import { z } from "zod";

const isTest = process.env.NODE_ENV === "test";
const normalizedEnv = {
  ...process.env,
  OPENROUTER_API_KEY:
    process.env.OPENROUTER_API_KEY ?? process.env.OROUTER_API_KEY
};

const envSchema = z.object({
  PORT: z.string().default("5000"),
  DATABASE_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/chatui?schema=public"),
  JWT_ACCESS_SECRET: z
    .string()
    .default("chatui-jwt-access-secret-fallback-key"),
  JWT_REFRESH_SECRET: z
    .string()
    .default("chatui-jwt-refresh-secret-fallback-key"),
  OPENROUTER_API_KEY: isTest
    ? z.string().optional().default("test")
    : z.string().default(""),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL_DEFAULT: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_MODEL_DEFAULT_FREE: z.string().optional(),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  RUNNER_BASE_URL: z.string().default("https://emkc.org/api/v2/piston"),
  RUNNER_TIMEOUT_MS: z.string().optional(),
  OWNER_EMAILS: z.string().default("rameshsingh9813@gmail.com")
});

export const env = envSchema.parse(normalizedEnv);

export const ownerEmails: Set<string> = new Set(
  env.OWNER_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

if (process.env.NODE_ENV === "production") {
  if (
    env.JWT_ACCESS_SECRET === "chatui-jwt-access-secret-fallback-key" ||
    env.JWT_REFRESH_SECRET === "chatui-jwt-refresh-secret-fallback-key"
  ) {
    console.warn(
      "⚠️ [WARN] Using default JWT secrets in production. Please set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in your Render environment variables."
    );
  }
  if (!env.OPENROUTER_API_KEY) {
    console.warn(
      "⚠️ [WARN] OPENROUTER_API_KEY is not set. Chat completions will return an error until it is provided in Render environment variables."
    );
  }
}

