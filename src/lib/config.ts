import { z } from "zod";

const isTest = process.env.NODE_ENV === "test";
const normalizedEnv = {
  ...process.env,
  OPENROUTER_API_KEY:
    process.env.OPENROUTER_API_KEY ?? process.env.OROUTER_API_KEY
};

const isPrivateHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "metadata.google.internal") return true;
  if (h.startsWith("10.")) return true;
  if (h.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === "169.254.169.254") return true;
  return false;
};

const httpsUrl = (defaultVal: string) =>
  z
    .string()
    .default(defaultVal)
    .refine(
      (v) => {
        if (!v) return true;
        try {
          const u = new URL(v);
          return u.protocol === "https:" || u.protocol === "http:";
        } catch {
          return false;
        }
      },
      { message: "Must be a valid http(s) URL" }
    )
    .refine(
      (v) => {
        if (!v) return true;
        try {
          const { hostname } = new URL(v);
          return !isPrivateHost(hostname);
        } catch {
          return true;
        }
      },
      { message: "URL points to a private/metadata host" }
    );

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
  OPENROUTER_BASE_URL: httpsUrl("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL_DEFAULT: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_MODEL_DEFAULT_FREE: z.string().optional(),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  // Brave Search API (AI grounding): when set, live web results come from
  // Brave's llm/context endpoint; otherwise the keyless DuckDuckGo chain is
  // used. Render env var name: BRAVE_API_KEY.
  BRAVE_API_KEY: z.string().default(""),
  // Exa AI search (RAG-optimized highlights). Render env var: EXA_API_KEY.
  EXA_API_KEY: z.string().default(""),
  RUNNER_PROVIDER: z.enum(["piston", "wandbox"]).default("wandbox"),
  RUNNER_BASE_URL: httpsUrl("https://emkc.org/api/v2/piston"),
  WANDBOX_BASE_URL: httpsUrl("https://wandbox.org"),
  RUNNER_TIMEOUT_MS: z.string().optional(),
  OWNER_EMAILS: z.string().default("rameshsingh9813@gmail.com"),
  ADMIN_EMAILS: z.string().default("rameshkumarmahato970@gmail.com"),
  // --- Canva connector (MCP client) ---
  CANVA_CLIENT_ID: z.string().default(""),
  CANVA_CLIENT_SECRET: z.string().default(""),
  // Must exactly match a redirect URL registered in the Canva developer portal.
  CANVA_REDIRECT_URI: z.string().default(""),
  // Space-separated, minimum scopes. Must all be enabled in the portal.
  CANVA_SCOPES: z
    .string()
    .default("design:content:read design:meta:read asset:read brandtemplate:meta:read profile:read folder:read"),
  CANVA_MCP_URL: httpsUrl("https://mcp.canva.com/mcp"),
  // 64 hex chars (32 bytes) for AES-256-GCM token encryption at rest.
  CONNECTOR_ENCRYPTION_KEY: z.string().default(""),
});

export const env = envSchema.parse(normalizedEnv);

export const ownerEmails: Set<string> = new Set(
  env.OWNER_EMAILS.split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean)
);

export const adminEmails: Set<string> = new Set(
  env.ADMIN_EMAILS.split(",")
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean)
);

const FAIL_SECRETS = new Set([
  "chatui-jwt-access-secret-fallback-key",
  "chatui-jwt-refresh-secret-fallback-key",
  "",
]);

const isWeakSecret = (v: string) => FAIL_SECRETS.has(v) || v.trim().length < 32;

if (process.env.NODE_ENV === "production") {
  if (
    isWeakSecret(env.JWT_ACCESS_SECRET) ||
    isWeakSecret(env.JWT_REFRESH_SECRET)
  ) {
    throw new Error(
      "FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set to strong random values (>=32 chars) in production. Refusing to start."
    );
  }
  if (env.CANVA_CLIENT_ID || env.CANVA_CLIENT_SECRET || env.CANVA_REDIRECT_URI) {
    if (!env.CONNECTOR_ENCRYPTION_KEY || !/^[0-9a-fA-F]{64}$/.test(env.CONNECTOR_ENCRYPTION_KEY.trim())) {
      throw new Error(
        "FATAL: CONNECTOR_ENCRYPTION_KEY must be 64 hex chars when Canva connector is configured. Generate with: openssl rand -hex 32"
      );
    }
  }
  if (!env.OPENROUTER_API_KEY) {
    console.warn(
      "⚠️ [WARN] OPENROUTER_API_KEY is not set. Chat completions will return an error until it is provided in Render environment variables."
    );
  }
}

