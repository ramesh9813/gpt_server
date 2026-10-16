/// <reference types="jest" />
jest.mock("../src/lib/prisma", () => ({
  prisma: {
    connectorToken: { findUnique: jest.fn() },
    connectorOAuthState: { create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  },
}));
import { DRIVE_TOOLS, DRIVE_TOOL_NAMES } from "../src/modules/connectors/google/googleDrive";
import { validateToolArgs } from "../src/modules/connectors/canva/canvaMcp";
import { getWebSearchToolDef, executeToolCallsParallel, isConnectorToolName } from "../src/modules/llm/toolBridge";
import { isConnectorProvider } from "../src/modules/connectors/tokenStore";

describe("google drive connector surface", () => {
  it("exposes list/search/read tools", () => {
    expect(DRIVE_TOOL_NAMES).toEqual(["list", "search", "read"]);
    expect(DRIVE_TOOLS).toHaveLength(3);
    for (const t of DRIVE_TOOLS) {
      expect(typeof t.name).toBe("string");
      expect((t.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  it("validates drive tool args like MCP tools", () => {
    const read = DRIVE_TOOLS.find((t) => t.name === "read")!;
    expect(validateToolArgs(read.inputSchema, { fileId: "abc" }).ok).toBe(true);
    const bad = validateToolArgs(read.inputSchema, {});
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("fileId");
  });

  it("routes both connector prefixes, rejects the rest", () => {
    expect(isConnectorToolName("drive__read")).toBe(true);
    expect(isConnectorToolName("drive__search")).toBe(true);
    expect(isConnectorToolName("canva__createDesign")).toBe(true);
    expect(isConnectorToolName("web__search")).toBe(true);
    expect(isConnectorToolName("web_search")).toBe(false);
  });

  it("exposes a model-callable web__search tool", () => {
    const def = getWebSearchToolDef();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("web__search");
    expect((def.function.parameters as { required?: string[] }).required).toEqual(["query"]);
  });

  it("runs parallel tool calls concurrently, keeping order and isolating failures", async () => {
    const out = await executeToolCallsParallel("u", [
      { id: "1", name: "web__nope", arguments: "{}" },
      { id: "2", name: "bogus", arguments: "{bad json" },
      { id: "3", name: "", arguments: "{}" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("1");
    expect(out[0].text).toContain("Unknown web tool");
    expect(out[1].id).toBe("2");
    expect(out[1].text).toContain("invalid JSON");
  });

  it("recognizes google as a connector provider", () => {
    expect(isConnectorProvider("google")).toBe(true);
    expect(isConnectorProvider("canva")).toBe(true);
    expect(isConnectorProvider("dropbox")).toBe(false);
  });
});
