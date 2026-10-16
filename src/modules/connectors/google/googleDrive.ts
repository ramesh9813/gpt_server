import { logger } from "../../../lib/logger";
import { getConnectorTokens, isAccessTokenExpired } from "../tokenStore";
import { validateToolArgs } from "../canva/canvaMcp";
import { GOOGLE_DRIVE_API, refreshGoogleTokens } from "./googleTokens";

export type DriveToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

// Static tool surface (no discovery round-trip needed — Drive v3 is fixed).
// toolBridge exposes these as drive__list / drive__search / drive__read.
export const DRIVE_TOOLS: DriveToolDef[] = [
  {
    name: "list",
    description:
      "List the user's Google Drive files (newest first). Use for browsing recent documents, spreadsheets and presentations.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Files to return (1-50, default 20)" },
        query: { type: "string", description: "Optional Drive search query (e.g. \"name contains 'budget'\")" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "Search Google Drive by file name and content. Returns matching files with ids for reading.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for in file names and content" },
        pageSize: { type: "integer", description: "Results to return (1-50, default 20)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description:
      "Read a Google Drive file's text by its file id (from list/search). Google Docs, Sheets and Slides are exported as text; plain-text files are downloaded (up to ~200KB).",
    inputSchema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The Drive file id to read" },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
  },
];

export const DRIVE_TOOL_NAMES = DRIVE_TOOLS.map((t) => t.name);

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
};

// Fresh access token, refreshing transparently. Null when never linked.
const driveAccessToken = async (userId: string): Promise<string | null> => {
  const stored = await getConnectorTokens(userId, "google");
  if (!stored) return null;
  if (!isAccessTokenExpired(stored)) return stored.accessToken;
  if (!stored.refreshToken) return stored.accessToken;
  return (await refreshGoogleTokens(userId)) ?? stored.accessToken;
};

const driveFetch = async (
  userId: string,
  path: string,
  params: Record<string, string> = {},
  init: RequestInit = {}
): Promise<Response> => {
  const run = async (token: string | null): Promise<Response | null> => {
    if (!token) return null;
    const url = new URL(`${GOOGLE_DRIVE_API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return fetch(url.toString(), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15000),
    });
  };
  let token = await driveAccessToken(userId);
  if (!token) {
    throw Object.assign(new Error("Google Drive is not connected"), { code: "NOT_CONNECTED" });
  }
  let res = await run(token);
  if (!res) {
    throw Object.assign(new Error("Google Drive is not connected"), { code: "NOT_CONNECTED" });
  }
  // One transparent retry with a rotated token on 401.
  if (res.status === 401) {
    const stored = await getConnectorTokens(userId, "google");
    if (stored?.refreshToken) {
      const rotated = await refreshGoogleTokens(userId);
      if (rotated && rotated !== token) {
        res = await run(rotated);
        if (!res) {
          throw Object.assign(new Error("Google Drive is not connected"), { code: "NOT_CONNECTED" });
        }
      }
    }
  }
  return res;
};

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

const toText = async (res: Response, capBytes: number): Promise<string> => {
  const buf = new Uint8Array(await res.arrayBuffer());
  const slice = buf.slice(0, capBytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return text + (buf.length > capBytes ? `\n…[truncated to first ${Math.round(capBytes / 1024)}KB]` : "");
};

const summarizeFiles = (files: DriveFile[]): string => {
  if (files.length === 0) return "No files found.";
  return files
    .map((f, i) => {
      const when = f.modifiedTime ? ` (modified ${f.modifiedTime.slice(0, 10)})` : "";
      const size = f.size ? ` [${Math.round(Number(f.size) / 1024)}KB]` : "";
      return `${i + 1}. ${f.name ?? "Untitled"} [${f.mimeType ?? "unknown type"}]${when}${size}\n   id: ${f.id}${f.webViewLink ? `\n   link: ${f.webViewLink}` : ""}`;
    })
    .join("\n");
};

const clampPageSize = (v: unknown): number => {
  const n = typeof v === "number" ? Math.floor(v) : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, n));
};

const listFiles = async (
  userId: string,
  args: { pageSize?: unknown; query?: unknown }
): Promise<string> => {
  const params: Record<string, string> = {
    pageSize: String(clampPageSize(args.pageSize)),
    orderBy: "modifiedTime desc",
    fields: `files(${FILE_FIELDS})`,
  };
  if (typeof args.query === "string" && args.query.trim()) {
    params.q = `${args.query.trim()} and trashed = false`;
  }
  const res = await driveFetch(userId, "/files", params);
  if (!res.ok) {
    logger.warn({ status: res.status }, "Drive files.list rejected");
    throw Object.assign(new Error(`Google Drive list failed (${res.status})`), { code: "DRIVE_ERROR", status: res.status });
  }
  const json = (await res.json()) as { files?: DriveFile[] };
  return summarizeFiles(Array.isArray(json.files) ? json.files : []);
};

const searchFiles = async (
  userId: string,
  args: { query?: unknown; pageSize?: unknown }
): Promise<string> => {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  if (!q) {
    throw Object.assign(new Error("Invalid arguments: missing required field: query"), {
      code: "INVALID_TOOL_ARGS",
    });
  }
  // Escape single quotes for the Drive query language.
  const esc = q.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return listFiles(userId, {
    pageSize: args.pageSize,
    query: `(name contains '${esc}' or fullText contains '${esc}')`,
  });
};

// Google Workspace exports with a text form (others — drawings, forms,
// binaries — get an exact note instead of garbage bytes).
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

const readFile = async (userId: string, args: { fileId?: unknown }): Promise<string> => {
  const fileId = typeof args.fileId === "string" ? args.fileId.trim() : "";
  if (!fileId) {
    throw Object.assign(new Error("Invalid arguments: missing required field: fileId"), {
      code: "INVALID_TOOL_ARGS",
    });
  }
  const metaRes = await driveFetch(userId, `/files/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
  });
  if (metaRes.status === 404) {
    throw Object.assign(new Error(`Drive file not found: ${fileId}`), { code: "NOT_FOUND" });
  }
  if (!metaRes.ok) {
    throw Object.assign(new Error(`Google Drive read failed (${metaRes.status})`), { code: "DRIVE_ERROR", status: metaRes.status });
  }
  const meta = (await metaRes.json()) as DriveFile;
  const mime = meta.mimeType ?? "";
  const title = meta.name ?? fileId;

  const exportMime = EXPORT_MIME[mime];
  if (exportMime) {
    const res = await driveFetch(
      userId,
      `/files/${encodeURIComponent(fileId)}/export`,
      { mimeType: exportMime, supportsAllDrives: "true" }
    );
    if (!res.ok) {
      throw Object.assign(new Error(`Google Drive export failed (${res.status})`), { code: "DRIVE_ERROR", status: res.status });
    }
    const text = await toText(res, 200 * 1024);
    return `File: ${title}\n${meta.webViewLink ? `${meta.webViewLink}\n` : ""}${text.trim() || "[export returned no text]"}`;
  }
  if (mime.startsWith("application/vnd.google-apps.")) {
    throw Object.assign(
      new Error(`Can't read ${title} as text (${mime || "Google Workspace file"} has no text export)`),
      { code: "UNSUPPORTED_FILE" }
    );
  }
  // Regular file: download directly (text path only — binaries get a note).
  const head = await driveFetch(userId, `/files/${encodeURIComponent(fileId)}`, {
    alt: "media",
    supportsAllDrives: "true",
  });
  if (!head.ok) {
    throw Object.assign(new Error(`Google Drive download failed (${head.status})`), { code: "DRIVE_ERROR", status: head.status });
  }
  const contentType = head.headers.get("content-type") ?? "";
  if (!/text|json|csv|xml|markdown|javascript|typescript/i.test(contentType) && !/text|json|csv|xml|md|txt|log|py|js|ts|java|c|cpp|go|rs|rb|php|sh|ya?ml|toml/i.test(mime)) {
    const kb = meta.size ? ` (${Math.round(Number(meta.size) / 1024)}KB)` : "";
    throw Object.assign(
      new Error(`Can't read ${title}${kb} as text (${mime || contentType || "binary file"})`),
      { code: "UNSUPPORTED_FILE" }
    );
  }
  const text = await toText(head, 200 * 1024);
  return `File: ${title}\n${meta.webViewLink ? `${meta.webViewLink}\n` : ""}${text.trim() || "[file is empty]"}`;
};

export const callDriveTool = async (
  userId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> => {
  const def = DRIVE_TOOLS.find((t) => t.name === toolName);
  if (!def) {
    throw Object.assign(new Error(`Unknown Drive tool: ${toolName}`), { code: "UNKNOWN_TOOL" });
  }
  const validation = validateToolArgs(def.inputSchema, toolArgs);
  if (!validation.ok) {
    throw Object.assign(new Error(`Invalid arguments: ${validation.errors.join("; ")}`), {
      code: "INVALID_TOOL_ARGS",
    });
  }
  const args = validation.cleaned;
  try {
    switch (toolName) {
      case "list":
        return await listFiles(userId, args);
      case "search":
        return await searchFiles(userId, args);
      case "read":
        return await readFile(userId, args);
      default:
        throw Object.assign(new Error(`Unknown Drive tool: ${toolName}`), { code: "UNKNOWN_TOOL" });
    }
  } catch (err) {
    // Expired consent (user revoked in Google) surfaces as NOT_CONNECTED so
    // the caller can ask to reconnect instead of showing a dead 401/403.
    const status = (err as { status?: unknown })?.status;
    if (status === 401 || status === 403) {
      const msg = status === 403
        ? "Google Drive access was denied — reconnect Google Drive to restore it."
        : "Google Drive session expired — reconnect Google Drive.";
      throw Object.assign(new Error(msg), { code: "NOT_CONNECTED" });
    }
    throw err;
  }
};
