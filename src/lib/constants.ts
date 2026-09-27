/**
 * Centralized constants for the server.
 * All magic numbers / TTLs / limits live here so they can be tuned in one place
 * and optionally overridden via env. No runtime side-effects.
 */

// ---------- HTTP / body ----------
export const JSON_BODY_LIMIT = "10mb" as const;

// ---------- Image / vision ----------
export const MAX_IMAGES = 3 as const;
export const MAX_IMAGE_STRING_LENGTH = 7 * 1024 * 1024; // ~7MB base64 string
export const IMAGE_ALLOWED_MIME = /^(jpeg|jpg|png|webp|gif)$/i;

// ---------- Runner ----------
export const RUNNER_OUTPUT_TRUNCATE_AT = 50_000 as const;
export const SUPPORTED_RUN_LANGUAGES = [
  "python",
  "py",
  "c",
  "cpp",
  "c++",
  "rust",
  "rs",
  "java",
] as const;
export type SupportedRunLanguage = (typeof SUPPORTED_RUN_LANGUAGES)[number];

// ---------- Video generation ----------
export const VIDEO_DEADLINE_MS = 8 * 60 * 1000;
export const VIDEO_MAX_BYTES = 15 * 1024 * 1024;

// ---------- History / prompt budgeting ----------
export const HISTORY = {
  LONG_LIMIT: 2000,
  HEAD_LEN: 1000,
  TAIL_LEN: 1000,
  COMPACT_LEN: 400,
  ANCHOR_LEN: 200,
  DEFAULT_RECENT_KEEP: 10,
  DEFAULT_CHAR_BUDGET: 24_000,
} as const;

// ---------- Cache TTLs ----------
export const CACHE_TTL_MS = 5 * 60 * 1000; // OpenRouter catalog
export const TOOLS_TTL_MS = 10 * 60 * 1000; // Canva MCP tools

// ---------- Timeouts (ms) ----------
export const TIMEOUT = {
  BYOK_MODELS: 10_000,
  BYOK_FOLLOWUP: 90_000,
  OPENROUTER_MCQ: 90_000,
  OPENROUTER_IMAGE: 90_000,
  OPENROUTER_VIDEO_SUBMIT: 30_000,
  OPENROUTER_VIDEO_POLL: 30_000,
  OPENROUTER_VIDEO_DOWNLOAD: 120_000,
  CANVA_CONNECT: 15_000,
  CANVA_CALL: 90_000,
  RUNNER_PISTON: 10_000,
  RUNNER_WANDBOX: 30_000,
} as const;

// ---------- Token / truncation budgets ----------
export const TOKEN = {
  RESEARCH_MAX_TOKENS: 8000,
  BYOK_REASONING_MAX_TOKENS: 8192,
  BYOK_DEFAULT_MAX_TOKENS: 4096,
  FOLLOWUPS_MAX_TOKENS: 150,
  MCQ_MAX_TOKENS_PER_QUESTION: 250,
  MCQ_MAX_TOKENS_CAP: 8000,
} as const;

// ---------- Rate limiting ----------
export const RATE_LIMIT = {
  AUTH: { windowMs: 15 * 60 * 1000, limit: 5 },
  CHAT: { windowMs: 60 * 1000, limit: 30 },
  RUNNER: { windowMs: 60 * 1000, limit: 10 },
  BYOK: { windowMs: 15 * 60 * 1000, limit: 30 },
  ADMIN: { windowMs: 60 * 1000, limit: 60 },
  GLOBAL: { windowMs: 60 * 1000, limit: 300 },
  MODELS: { windowMs: 60 * 1000, limit: 60 },
} as const;

// ---------- Misc slices ----------
export const SLICE = {
  BYOK_ERROR_DETAIL: 500,
  VIDEO_PROVIDER_REASON: 200,
  MCQ_EXCLUSION_QUESTION: 120,
  HISTORY_HEAD_TAIL: 1000,
} as const;
