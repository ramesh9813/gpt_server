import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../../../lib/logger";
import {
  getConnectorTokens,
  isAccessTokenExpired,
} from "../tokenStore";
import {
  CANVA_MCP_URL,
  refreshCanvaTokens,
} from "./canvaTokens";

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

type CachedConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: McpToolDef[];
  toolsFetchedAt: number;
  connecting: Promise<Client> | null;
};

const connections = new Map<string, CachedConnection>();
const TOOLS_TTL_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    (async () => {
      await sleep(ms);
      throw new Error(`${label} timed out after ${ms}ms`);
    })(),
  ]);

// Retries transient failures with exponential backoff (500ms → 1s → 2s).
const withBackoff = async <T,>(
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> => {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isAuthError(err)) throw err;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
};

const isAuthError = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message} ${(err as { status?: unknown }).status ?? ""}` : String(err);
  return /401|unauthorized/i.test(msg);
};

const buildTransport = (accessToken: string): StreamableHTTPClientTransport =>
  new StreamableHTTPClientTransport(new URL(CANVA_MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });

const dial = async (userId: string, accessToken: string): Promise<CachedConnection> => {
  const client = new Client(
    { name: "chatui-canva-connector", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = buildTransport(accessToken);
  // Redact loudly: the SDK must never see a chance to log our header.
  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "Canva MCP connect");
  logger.info({ userId }, "Canva MCP connected");
  return { client, transport, tools: [], toolsFetchedAt: 0, connecting: null };
};

// Returns a live client, refreshing + reconnecting transparently.
// Throws NOT_CONNECTED when the user never linked Canva.
export const getUserConnection = async (userId: string): Promise<Client> => {
  const existing = connections.get(userId);
  if (existing && !existing.connecting) {
    try {
      // Cheap liveness probe via cached tools; real failures surface per-call.
      return existing.client;
    } catch {
      connections.delete(userId);
    }
  }
  if (existing?.connecting) return existing.connecting;

  const connectTask: Promise<Client> = (async () => {
    const stored = await getConnectorTokens(userId, "canva");
    if (!stored) {
      connections.delete(userId);
      throw Object.assign(new Error("Canva is not connected"), { code: "NOT_CONNECTED" });
    }
    let accessToken = stored.accessToken;
    if (isAccessTokenExpired(stored) && stored.refreshToken) {
      accessToken = (await refreshCanvaTokens(userId)) ?? accessToken;
    }
    try {
      const conn = await withBackoff(() => dial(userId, accessToken));
      connections.set(userId, conn);
      return conn.client;
    } catch (err) {
      // One transparent retry with a rotated token on 401.
      if (isAuthError(err) && stored.refreshToken) {
        const rotated = await refreshCanvaTokens(userId);
        if (rotated && rotated !== accessToken) {
          const conn = await withBackoff(() => dial(userId, rotated));
          connections.set(userId, conn);
          return conn.client;
        }
      }
      connections.delete(userId);
      throw err;
    }
  })();

  connections.set(userId, {
    client: undefined as unknown as Client,
    transport: undefined as unknown as StreamableHTTPClientTransport,
    tools: [],
    toolsFetchedAt: 0,
    connecting: connectTask,
  });
  try {
    const client = await connectTask;
    const conn = connections.get(userId);
    if (conn) conn.connecting = null;
    return client;
  } catch (err) {
    connections.delete(userId);
    throw err;
  }
};

export const listCanvaTools = async (userId: string): Promise<McpToolDef[]> => {
  const client = await getUserConnection(userId);
  const conn = connections.get(userId);
  if (conn && conn.tools.length > 0 && Date.now() - conn.toolsFetchedAt < TOOLS_TTL_MS) {
    return conn.tools;
  }
  const res = await withBackoff(() =>
    withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "Canva listTools")
  );
  const tools: McpToolDef[] = (res.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
  }));
  if (conn) {
    conn.tools = tools;
    conn.toolsFetchedAt = Date.now();
  }
  return tools;
};

// Minimal JSON-schema gate for LLM-generated arguments: required fields,
// property types, enums, and additionalProperties. Rejects (never coerces)
// so the model can't smuggle unexpected payloads into Canva.
export const validateToolArgs = (
  schema: Record<string, unknown>,
  args: unknown
): { ok: boolean; errors: string[]; cleaned: Record<string, unknown> } => {
  const errors: string[] = [];
  if (typeof schema !== "object" || schema === null) return { ok: true, errors, cleaned: {} };
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ok: false, errors: ["arguments must be an object"], cleaned: {} };
  }
  const input = args as Record<string, unknown>;
  const type = (schema as { type?: unknown }).type;
  if (type !== undefined && type !== "object") {
    return { ok: false, errors: [`unsupported tool schema type: ${String(type)}`], cleaned: {} };
  }
  const props = ((schema as { properties?: unknown }).properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = ((schema as { required?: unknown }).required ?? []) as string[];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) errors.push(`missing required field: ${key}`);
  }
  const allowExtra = (schema as { additionalProperties?: unknown }).additionalProperties !== false;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const def = props[key];
    if (!def) {
      if (!allowExtra) {
        errors.push(`unknown field: ${key}`);
        continue;
      }
      cleaned[key] = value;
      continue;
    }
    const check = checkType(key, value, def);
    if (check) errors.push(check);
    else cleaned[key] = value;
  }
  return { ok: errors.length === 0, errors, cleaned };
};

const checkType = (key: string, value: unknown, def: Record<string, unknown>): string | null => {
  const expected = def.type as string | undefined;
  if (def.enum !== undefined && Array.isArray(def.enum)) {
    if (!(def.enum as unknown[]).includes(value)) {
      return `${key} must be one of: ${(def.enum as unknown[]).map(String).join(", ")}`;
    }
  }
  if (expected === undefined) return null;
  switch (expected) {
    case "string":
      if (typeof value !== "string") return `${key} must be a string`;
      if (value.length > 20_000) return `${key} exceeds 20000 characters`;
      return null;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return `${key} must be a number`;
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${key} must be an integer`;
      return null;
    case "boolean":
      if (typeof value !== "boolean") return `${key} must be a boolean`;
      return null;
    case "array":
      if (!Array.isArray(value)) return `${key} must be an array`;
      if (value.length > 100) return `${key} exceeds 100 items`;
      return null;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return `${key} must be an object`;
      }
      return null;
    default:
      return null;
  }
};

export const callCanvaTool = async (
  userId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<unknown> => {
  const tools = await listCanvaTools(userId);
  const def = tools.find((t) => t.name === toolName);
  if (!def) {
    throw Object.assign(new Error(`Unknown Canva tool: ${toolName}`), { code: "UNKNOWN_TOOL" });
  }
  const validation = validateToolArgs(def.inputSchema, toolArgs);
  if (!validation.ok) {
    throw Object.assign(new Error(`Invalid arguments: ${validation.errors.join("; ")}`), {
      code: "INVALID_TOOL_ARGS",
    });
  }
  const attempt = async (): Promise<unknown> => {
    const client = await getUserConnection(userId);
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: validation.cleaned }),
      CALL_TIMEOUT_MS,
      `Canva tool ${toolName}`
    );
    return res;
  };
  try {
    return await withBackoff(attempt);
  } catch (err) {
    if (isAuthError(err)) {
      // Drop the stale connection, rotate, reconnect once, retry once.
      await closeUserConnection(userId);
      const rotated = await refreshCanvaTokens(userId);
      if (!rotated) throw err;
      return withTimeout(
        (await getUserConnection(userId)).callTool({ name: toolName, arguments: validation.cleaned }),
        CALL_TIMEOUT_MS,
        `Canva tool ${toolName} (retry)`
      );
    }
    throw err;
  }
};

// Tool names already cached in-memory (no Canva round-trip) — safe for the
// lightweight status endpoint. The client only ever sees names.
export const getCachedToolNames = (userId: string): string[] => {
  const conn = connections.get(userId);
  if (!conn || conn.connecting) return [];
  return conn.tools.map((t) => t.name);
};

export const closeUserConnection = async (userId: string): Promise<void> => {  const conn = connections.get(userId);
  connections.delete(userId);
  if (!conn || conn.connecting) return;
  try {
    await conn.client.close();
  } catch {
    // already dead — cache entry is gone, which is what matters
  }
  logger.info({ userId }, "Canva MCP connection closed");
};
