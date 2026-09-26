import { prisma } from "../../lib/prisma";
import { listCanvaTools, callCanvaTool, type McpToolDef } from "../connectors/canva/canvaMcp";
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

const PROVIDER_PREFIX = "canva__";
const MAX_TOOL_RESULT_CHARS = 8000;

export const isConnectorToolName = (name: string): boolean =>
  name.startsWith(PROVIDER_PREFIX);

const toLlmName = (toolName: string): string => `${PROVIDER_PREFIX}${toolName}`;
const fromLlmName = (llmName: string): string => llmName.slice(PROVIDER_PREFIX.length);

export const isCanvaConnected = async (userId: string): Promise<boolean> => {
  const row = await prisma.connectorToken.findUnique({
    where: { userId_provider: { userId, provider: "canva" } },
  });
  return !!row;
};

// MCP tools in OpenAI function-calling format. Returns [] (no behavior
// change) when the user never linked Canva or listing fails.
export const getAvailableTools = async (userId: string): Promise<LlmToolDef[]> => {
  try {
    if (!(await isCanvaConnected(userId))) return [];
    const tools = await listCanvaTools(userId);
    return tools.map((t: McpToolDef) => ({
      type: "function" as const,
      function: {
        name: toLlmName(t.name),
        description: t.description ?? `Canva MCP tool: ${t.name}`,
        parameters:
          t.inputSchema &&
          typeof t.inputSchema === "object" &&
          Object.keys(t.inputSchema).length > 0
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      },
    }));
  } catch (err) {
    logger.warn({ err, userId }, "Canva tool listing failed; continuing without tools");
    return [];
  }
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

// Executes one LLM-requested MCP tool call and returns plain text for the
// conversation loop. Throws with code NOT_CONNECTED / UNKNOWN_TOOL /
// INVALID_TOOL_ARGS for the caller to translate.
export const executeMcpTool = async (
  userId: string,
  llmToolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> => {
  if (!isConnectorToolName(llmToolName)) {
    throw Object.assign(new Error(`Not a connector tool: ${llmToolName}`), {
      code: "NOT_CONNECTOR_TOOL",
    });
  }
  const raw = await callCanvaTool(userId, fromLlmName(llmToolName), toolArgs);
  const text = contentToText(raw);
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
    : text;
};
