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
  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  OPENROUTER_API_KEY: isTest
    ? z.string().optional().default("test")
    : z.string(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL_DEFAULT: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_MODEL_DEFAULT_FREE: z.string().optional(),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  RUNNER_BASE_URL: z.string().default("https://emkc.org/api/v2/piston"),
  RUNNER_TIMEOUT_MS: z.string().optional()
});

export const env = envSchema.parse(normalizedEnv);
