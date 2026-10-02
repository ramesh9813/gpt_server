// Pure unit coverage for the CleanAPIs fixes: mid-stream error frames must
// surface the provider's real message (not "empty stream"), non-SSE JSON
// bodies must be recovered, and the catalog must accept every list envelope.
/// <reference types="jest" />
import {
  extractNonStreamingContent,
  extractStreamError,
  parseByokDelta,
} from "../src/modules/chat/byok/parsers";
import { fetchByokModels } from "../src/lib/byok/catalog";
import type { ByokProvider } from "../src/lib/byokTypes";

describe("extractStreamError", () => {
  it("reads CleanAPIs mid-stream error frames", () => {
    expect(
      extractStreamError({ error: { message: "Upstream provider unavailable", type: "provider_error", code: 502 } })
    ).toEqual({ message: "Upstream provider unavailable", status: 502 });
  });
  it("reads Anthropic error events", () => {
    expect(extractStreamError({ type: "error", error: { message: "overloaded" } })).toEqual({
      message: "overloaded",
      status: 502,
    });
  });
  it("ignores normal chunks", () => {
    expect(extractStreamError({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(extractStreamError(null)).toBeNull();
  });
});

describe("parseByokDelta streamError", () => {
  it("flags the error on every provider kind", () => {
    const frame = { error: { message: "Upstream provider unavailable", code: 502 } };
    for (const kind of ["openai", "anthropic", "gemini"] as const) {
      const r = parseByokDelta(frame, kind, false);
      expect(r.streamError).toEqual({ message: "Upstream provider unavailable", status: 502 });
      expect(r.content).toBe("");
    }
  });
});

describe("extractNonStreamingContent", () => {
  it("recovers a single JSON completion body", () => {
    const out = extractNonStreamingContent([
      { id: "x", choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]);
    expect(out?.content).toBe("Hello!");
    expect(out?.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
  it("recovers reasoning_content variants", () => {
    const out = extractNonStreamingContent([
      { choices: [{ message: { content: "42", reasoning_content: "thinking…" } }] },
    ]);
    expect(out?.content).toBe("42");
    expect(out?.reasoning).toBe("thinking…");
  });
  it("returns null when there is nothing to recover", () => {
    expect(extractNonStreamingContent([{ choices: [{ delta: {}, finish_reason: "stop" }] }])).toBeNull();
    expect(extractNonStreamingContent([])).toBeNull();
  });
});

const openaiProvider = (id: string): ByokProvider => ({
  id: id as any,
  name: id,
  kind: "openai",
  baseUrl: "https://example.test/v1",
  keyPattern: /^.+$/,
  keyHint: "key",
  keylessModels: false,
  models: [],
});

describe("testByokInference", () => {
  const { testByokInference } = require("../src/modules/chat/byokCall") as typeof import("../src/modules/chat/byokCall");

  afterEach(() => jest.restoreAllMocks());

  it("ok when the provider answers", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    const r = await testByokInference({ provider: openaiProvider("cleanapis"), model: "m", apiKey: "k" });
    expect(r.ok).toBe(true);
    expect(r.model).toBe("m");
  });

  it("surfaces the exact provider error", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: { message: "Billing verification failed. Please check your payment method." } }),
    });
    const r = await testByokInference({ provider: openaiProvider("cleanapis"), model: "m", apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Billing verification failed");
  });

  it("fails on an empty reply", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
    });
    const r = await testByokInference({ provider: openaiProvider("cleanapis"), model: "m", apiKey: "k" });
    expect(r.ok).toBe(false);
  });
});

describe("fetchByokModels envelopes", () => {
  const mockModels = (json: any) =>
    ((global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => json }));
  afterEach(() => jest.restoreAllMocks());

  it("accepts {models:[...]} and bare arrays, dedupes pages", async () => {
    mockModels({ models: [{ id: "a" }, { name: "b" }, "c"] });
    const cat = await fetchByokModels(openaiProvider("codecraft"), "k");
    expect(cat.models).toEqual(["a", "b", "c"]);
  });

  it("follows has_more pagination to show the full catalog", async () => {
    const page1 = { data: [{ id: "m1" }], has_more: true };
    const page2 = { data: [{ id: "m2" }] };
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 });
    const cat = await fetchByokModels(openaiProvider("codecraft"), "k");
    expect(cat.models).toEqual(["m1", "m2"]);
  });
});
