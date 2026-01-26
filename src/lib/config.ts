import { z } from "zod";

const isTest = process.env.NODE_ENV === "test";

const envSchema = z.object({
  PORT: z.string().default("5000"),
  DATABASE_URL: z.string().default("file:./dev.db"),
  JWT_ACCESS_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  OROUTER_API_KEY: isTest
    ? z.string().optional().default("test")
    : z.string(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL_DEFAULT: z.string().default("openai/gpt-4o-mini"),
  APP_ORIGIN: z.string().default("http://localhost:5173")
});

export const env = envSchema.parse(process.env);