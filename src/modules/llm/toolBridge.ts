import { prisma } from "../../lib/prisma";
import { listCanvaTools, callCanvaTool, type McpToolDef } from "../connectors/canva/canvaMcp";
import { DRIVE_TOOLS, callDriveTool, type DriveToolDef } from "../connectors/google/googleDrive";
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
const MAX_TOOL_RESULT_CHARS = 8000;

export const isConnectorToolName = (name: string): boolean =>
  name.startsWith(CANVA_PREFIX) || name.startsWith(DRIVE_PREFIX);

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

// Executes one LLM-requested connector tool call and returns plain text for
// the conversation loop. Throws with code NOT_CONNECTED / UNKNOWN_TOOL /
// INVALID_TOOL_ARGS for the caller to translate.
export const executeMcpTool = async (
  userId: string,
  llmToolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> => {
  let raw: unknown;
  if (llmToolName.startsWith(DRIVE_PREFIX)) {
    raw = await callDriveTool(userId, llmToolName.slice(DRIVE_PREFIX.length), toolArgs);
  } else if (llmToolName.startsWith(CANVA_PREFIX)) {
    raw = await callCanvaTool(userId, llmToolName.slice(CANVA_PREFIX.length), toolArgs);
  } else {
    throw Object.assign(new Error(`Not a connector tool: ${llmToolName}`), {
      code: "NOT_CONNECTOR_TOOL",
    });
  }
  const text = contentToText(raw);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
    : text;
};
