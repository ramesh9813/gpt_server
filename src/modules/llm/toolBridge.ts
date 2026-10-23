import { prisma } from "../../lib/prisma";
import { listCanvaTools, callCanvaTool, type McpToolDef } from "../connectors/canva/canvaMcp";
import { DRIVE_TOOLS, callDriveTool, type DriveToolDef } from "../connectors/google/googleDrive";
import {
  buildSearchContextBlock,
  performWebSearchWithProvider,
  type WebResult,
} from "../../lib/websearch";
import { resolveSearchDepth, resolveSearchProvider } from "../../lib/searchSettings";
import { logger } from "../../lib/logger";

// NOTE: this app's LLM is OpenRouter (OpenAI-compatible chat completions),
// so MCP tools are exposed in OpenAI function-calling schema.
export type LlmToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

const CANVA_PREFIX = "canva__";
const DRIVE_PREFIX = "drive__";
const WEB_PREFIX = "web__";
const MAX_TOOL_RESULT_CHARS = 8000;

export const isConnectorToolName = (name: string): boolean =>
  name.startsWith(CANVA_PREFIX) || name.startsWith(DRIVE_PREFIX) || name.startsWith(WEB_PREFIX);

export const isCanvaConnected = async (userId: string): Promise<boolean> => {
  const row = await prisma.connectorToken.findUnique({
    where: { userId_provider: { userId, provider: "canva" } },
  });
  return !!row;
};

export const isGoogleConnected = async (userId: string): Promise<boolean> => {
  const row = await prisma.connectorToken.findUnique({
    where: { userId_provider: { userId, provider: "google" } },
  });
  return !!row;
};

type NamedToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

const toLlmTools = (prefix: string, label: string, tools: NamedToolDef[]): LlmToolDef[] =>
  tools.map((t) => ({
    type: "function" as const,
    function: {
      name: `${prefix}${t.name}`,
      description: t.description ?? `${label} tool: ${t.name}`,
      parameters:
        t.inputSchema &&
        typeof t.inputSchema === "object" &&
        Object.keys(t.inputSchema).length > 0
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    },
  }));

// Connector tools in OpenAI function-calling format. Returns [] (no behavior
// change) when the user linked nothing or listing fails.
export const getAvailableTools = async (userId: string): Promise<LlmToolDef[]> => {
  const out: LlmToolDef[] = [];
  try {
    if (await isCanvaConnected(userId)) {
      const tools = await listCanvaTools(userId);
      out.push(...toLlmTools(CANVA_PREFIX, "Canva MCP", tools as McpToolDef[]));
    }
  } catch (err) {
    logger.warn({ err, userId }, "Canva tool listing failed; continuing without tools");
  }
  try {
    if (await isGoogleConnected(userId)) {
      out.push(...toLlmTools(DRIVE_PREFIX, "Google Drive", DRIVE_TOOLS as DriveToolDef[]));
    }
  } catch (err) {
    logger.warn({ err, userId }, "Drive tool listing failed; continuing without tools");
  }
  return out;
};

const contentToText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown };
          if (typeof b.text === "string") parts.push(b.text);
          else if (b.type === "image") parts.push(`[image${b.mimeType ? ` ${b.mimeType}` : ""} returned]`);
          else if (b.type === "resource") parts.push("[resource returned]");
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
    try {
      return JSON.stringify(result);
    } catch {
      return String(result);
    }
  }
  return String(result ?? "");
};

// Model-callable live web search: the selected model invokes this itself
// (parallel fan-out across providers) whenever it judges it needs fresh
// facts — including follow-up searches mid-turn that server pre-injection
// can't foresee. No images here (fast text path); URLs ride as links.
export const getWebSearchToolDef = (): LlmToolDef => ({
  type: "function" as const,
  function: {
    name: `${WEB_PREFIX}search`,
    description:
      "Search the live web (Brave, Exa, YouTube, DuckDuckGo queried in parallel). Use when you need current facts, news, prices, scores or anything beyond training data. Returns titles, URLs and content snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max: { type: "number", description: "Max results (3-20, default is the user's Search settings depth)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
});

const runWebSearchTool = async (
  userId: string,
  toolArgs: Record<string, unknown>
): Promise<{ text: string; sources: WebResult[] }> => {
  const rawQuery = typeof toolArgs.query === "string" ? toolArgs.query.trim().slice(0, 500) : "";
  if (!rawQuery) {
    throw Object.assign(new Error("Invalid arguments: missing required field: query"), {
      code: "INVALID_TOOL_ARGS",
    });
  }
  const depth = await resolveSearchDepth(userId);
  const n = typeof toolArgs.max === "number" && Number.isFinite(toolArgs.max)
    ? Math.min(20, Math.max(3, Math.floor(toolArgs.max)))
    : depth;
  const provider = await resolveSearchProvider(userId);
  const { hits } = await performWebSearchWithProvider(rawQuery, n, provider);
  if (hits.length === 0) return { text: "No web results found.", sources: [] };
  return { text: buildSearchContextBlock(rawQuery, hits), sources: hits };
};

// Parallel orchestration cap: one model turn may fan out this many tool
// calls at once (parallel subagents). Results re-attach in request order.
export const MAX_PARALLEL_TOOL_CALLS = 8;

// Runs every requested call CONCURRENTLY and returns plain-text results in
// request order — wall-clock is the slowest tool, not the sum. Invalid args
// and per-tool failures become inline Error texts (never throw), so one bad
// call can't sink its siblings.
export type ToolCallResult = {
  id: string;
  text: string;
  sources?: Array<{ title: string; url: string; snippet?: string; image?: string }>;
};

export const executeToolCallsParallel = async (
  userId: string,
  calls: Array<{ id: string; name: string; arguments: string }>
): Promise<ToolCallResult[]> => {
  const capped = calls.filter((c) => c.name).slice(0, MAX_PARALLEL_TOOL_CALLS);
  const settled = await Promise.allSettled(
    capped.map(async (tc) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        const raw = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
        parsedArgs = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      } catch {
        return {
          id: tc.id,
          text: "Error: the model produced invalid JSON arguments and they were rejected.",
        };
      }
      try {
        const result = await executeMcpToolDetailed(userId, tc.name, parsedArgs);
        return {
          id: tc.id,
          text: result.text,
          ...(result.sources && result.sources.length > 0 ? { sources: result.sources } : {}),
        };
      } catch (err: unknown) {
        const msg = (err as { message?: unknown })?.message;
        return { id: tc.id, text: `Error: ${typeof msg === "string" && msg ? msg : "tool execution failed"}` };
      }
    })
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { id: capped[i]?.id ?? "", text: "Error: tool execution failed" }
  );
};

// Executes one LLM-requested tool call. Web search also returns its
// structured hits so the streamer can persist/emit source links; connector
// tools return text only. Throws with code NOT_CONNECTED / UNKNOWN_TOOL /
// INVALID_TOOL_ARGS for the caller to translate.
const executeMcpToolDetailed = async (
  userId: string,
  llmToolName: string,
  toolArgs: Record<string, unknown>
): Promise<{ text: string; sources?: WebResult[] }> => {
  let raw: unknown;
  let sources: WebResult[] | undefined;
  if (llmToolName.startsWith(WEB_PREFIX)) {
    if (llmToolName !== `${WEB_PREFIX}search`) {
      throw Object.assign(new Error(`Unknown web tool: ${llmToolName}`), {
        code: "UNKNOWN_TOOL",
      });
    }
    const result = await runWebSearchTool(userId, toolArgs);
    raw = result.text;
    sources = result.sources;
  } else if (llmToolName.startsWith(DRIVE_PREFIX)) {
    raw = await callDriveTool(userId, llmToolName.slice(DRIVE_PREFIX.length), toolArgs);
  } else if (llmToolName.startsWith(CANVA_PREFIX)) {
    raw = await callCanvaTool(userId, llmToolName.slice(CANVA_PREFIX.length), toolArgs);
  } else {
    throw Object.assign(new Error(`Not a connector tool: ${llmToolName}`), {
      code: "NOT_CONNECTOR_TOOL",
    });
  }
  const text = contentToText(raw);
  return {
    text:
      text.length > MAX_TOOL_RESULT_CHARS
        ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
        : text,
    ...(sources ? { sources } : {}),
  };
};

export const executeMcpTool = async (
  userId: string,
  llmToolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> => (await executeMcpToolDetailed(userId, llmToolName, toolArgs)).text;
