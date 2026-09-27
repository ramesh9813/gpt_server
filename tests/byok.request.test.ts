// Request-shape coverage for every BYOK provider kind. Guards the bugs we hit
// in practice: strict gateways 422ing on stream_options, wrong endpoints for
// Gemini/Anthropic, missing thinking/web-search wiring, wrong auth headers.
import { BYOK_PROVIDERS, parseByokHeaders, type ByokProviderId } from "../src/lib/byok";
import { buildByokStreamRequest, byokErrorMessage } from "../src/modules/chat/byokRequest";
import type { OpenRouterMessage } from "../src/modules/chat/chat.service";

const MESSAGES: OpenRouterMessage[] = [
  { role: "system", content: "You are helpful." },
  { role: "user", content: "make a counter simulation" },
];
const key = "TESTKEY_1234567890abcdefghij";
const mk = (id: ByokProviderId) => ({
  provider: BYOK_PROVIDERS[id],
  model: "test-model",
  apiKey: key,
});

const OPENAI_KIND_IDS: ByokProviderId[] = [
  "openrouter",
  "openai",
  "grok",
  "meta",
  "nvidia",
  "deepseek",
  "qwen",
  "moonshot",
  "groq",
  "mistral",
  "cleanapis",
  "infron",
  "apinex",
  "codecraft",
];

describe("buildByokStreamRequest per provider", () => {
  it.each(OPENAI_KIND_IDS)("%s → POST /chat/completions, no thinking extras", (id) => {
    const req = buildByokStreamRequest(mk(id), MESSAGES);
    expect(req.url).toBe(`${BYOK_PROVIDERS[id].baseUrl}/chat/completions`);
    expect(req.headers.Authorization).toBe(`Bearer ${key}`);
    expect(req.body.model).toBe("test-model");
    expect(req.body.stream).toBe(true);
    expect(Array.isArray(req.body.messages)).toBe(true);
    expect(req.body.thinking).toBeUndefined();
  });

  it("only OpenAI/OpenRouter stream with usage chunks (strict gateways 422 otherwise)", () => {
    const withUsage: ByokProviderId[] = ["openai", "openrouter"];
    const withoutUsage = OPENAI_KIND_IDS.filter((id) => !withUsage.includes(id));
    for (const id of withUsage) {
      expect(buildByokStreamRequest(mk(id), MESSAGES).body.stream_options).toEqual({
        include_usage: true,
      });
    }
    for (const id of withoutUsage) {
      expect(buildByokStreamRequest(mk(id), MESSAGES).body.stream_options).toBeUndefined();
    }
  });

  it("openrouter adds attribution headers + a native web_search tool when enabled", () => {
    const off = buildByokStreamRequest(mk("openrouter"), MESSAGES);
    expect(off.headers["HTTP-Referer"]).toBeDefined();
    expect(off.body.tools).toBeUndefined();
    const on = buildByokStreamRequest(mk("openrouter"), MESSAGES, { webSearch: true });
    expect(Array.isArray(on.body.tools)).toBe(true);
    expect((on.body.tools as any[])[0].type).toBe("openrouter:web_search");
    // OpenRouter BYOK reasoning passthrough needs nothing special in the body.
    const thinking = buildByokStreamRequest(mk("openrouter"), MESSAGES, { think: true });
    expect(thinking.body.thinking).toBeUndefined();
  });

  it("gemini hits streamGenerateContent with systemInstruction + x-goog-api-key", () => {
    const req = buildByokStreamRequest(mk("google"), MESSAGES);
    expect(req.url).toBe(`${BYOK_PROVIDERS.google.baseUrl}/models/test-model:streamGenerateContent?alt=sse`);
    expect(req.headers["x-goog-api-key"]).toBe(key);
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.body.systemInstruction).toBeDefined();
    expect(Array.isArray(req.body.contents)).toBe(true);
  });

  it("gemini thinking mode adds thinkingConfig only when armed", () => {
    const plain = buildByokStreamRequest(mk("google"), MESSAGES);
    expect(plain.body.generationConfig).toBeUndefined();
    const thinking = buildByokStreamRequest(mk("google"), MESSAGES, { think: true });
    expect(thinking.body.generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true },
    });
  });

  it("anthropic hits /messages with x-api-key, alternating messages, and thinking budget in think mode", () => {
    const plain = buildByokStreamRequest(mk("anthropic"), MESSAGES);
    expect(plain.url).toBe(`${BYOK_PROVIDERS.anthropic.baseUrl}/messages`);
    expect(plain.headers["x-api-key"]).toBe(key);
    expect(plain.headers["anthropic-version"]).toBe("2023-06-01");
    expect(plain.body.stream).toBe(true);
    expect(plain.body.thinking).toBeUndefined();
    expect(plain.body.max_tokens).toBe(4096);
    expect(plain.body.system).toBe("You are helpful.");

    const thinking = buildByokStreamRequest(mk("anthropic"), MESSAGES, { think: true });
    expect(thinking.body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(thinking.body.max_tokens).toBe(8192);
  });

  it("codecraft uses the official base URL without usage chunks", () => {
    const req = buildByokStreamRequest(mk("codecraft"), MESSAGES);
    expect(req.url).toBe("https://codecraftapi.com/v1/chat/completions");
    expect(req.body.stream_options).toBeUndefined();
    expect(req.headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("artifact turns raise the output ceiling so simulations complete", () => {
    // OpenAI-compatible: no cap on plain turns, 16000 on artifact turns.
    const plainOpenai = buildByokStreamRequest(mk("openai"), MESSAGES);
    expect(plainOpenai.body.max_tokens).toBeUndefined();
    const artifactOpenai = buildByokStreamRequest(mk("openai"), MESSAGES, { artifact: true });
    expect(artifactOpenai.body.max_tokens).toBe(16000);
    // Anthropic: artifact beats the thinking default.
    expect(buildByokStreamRequest(mk("anthropic"), MESSAGES, { artifact: true }).body.max_tokens).toBe(16000);
    expect(buildByokStreamRequest(mk("anthropic"), MESSAGES, { think: true, artifact: true }).body.max_tokens).toBe(16000);
    // Gemini: artifact sets its own (lower, universally accepted) ceiling,
    // merged with thinking config when both are armed.
    const plainGemini = buildByokStreamRequest(mk("google"), MESSAGES);
    expect(plainGemini.body.generationConfig).toBeUndefined();
    const artifactGemini = buildByokStreamRequest(mk("google"), MESSAGES, { artifact: true });
    expect(artifactGemini.body.generationConfig).toEqual({ maxOutputTokens: 8192 });
    const bothGemini = buildByokStreamRequest(mk("google"), MESSAGES, { think: true, artifact: true });
    expect(bothGemini.body.generationConfig).toEqual({
      thinkingConfig: { includeThoughts: true },
      maxOutputTokens: 8192,
    });
  });

  it("maps provider statuses to actionable error text", () => {
    expect(
      byokErrorMessage("CodeCraft API", 401, "Invalid or revoked API key.")
    ).toContain("Invalid or revoked API key.");
    expect(byokErrorMessage("CodeCraft API", 402, "")).toContain("Out of balance");
    expect(byokErrorMessage("CodeCraft API", 403, "")).toContain("scopes");
    expect(byokErrorMessage("CodeCraft API", 404, "")).toContain("Unknown model");
    // Raw provider detail is preserved, truncated to 500 chars.
    expect(byokErrorMessage("CodeCraft API", 500, "boom")).toContain("boom");
    expect(byokErrorMessage("CodeCraft API", 500, "x".repeat(600))).toHaveLength(
      "CodeCraft API error (500): ".length + 500
    );
    // OpenAI error envelope: surface the human message, not raw JSON.
    expect(
      byokErrorMessage("CodeCraft API", 500, '{"error":{"message":"boom"}}')
    ).toBe("CodeCraft API error (500): boom");
  });

  it("maps 422 validation and 429 rate-limit statuses", () => {
    expect(byokErrorMessage("CodeCraft API", 422, "")).toContain("Invalid request");
    expect(byokErrorMessage("CodeCraft API", 429, "")).toContain("Rate limited");
  });

  it("names the firewall — never the key — for challenge pages", () => {
    const challenge =
      '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta src="https://challenges.cloudflare.com">';
    const msg = byokErrorMessage("CodeCraft API", 403, challenge);
    expect(msg).toContain("firewall");
    expect(msg).not.toContain("scopes");
    expect(msg).not.toContain("<!DOCTYPE");
  });

  it("strips a echoed provider:model prefix so codecraft never 404s on it", () => {
    const req = (model?: string) =>
      parseByokHeaders({
        headers: {
          "x-byok-provider": "codecraft",
          ...(model !== undefined ? { "x-byok-model": model } : {}),
          "x-byok-key": `cc_${"k".repeat(48)}`,
        },
      } as any);
    expect(req("codecraft:gpt-5.6-luna")).toMatchObject({
      provider: BYOK_PROVIDERS.codecraft,
      model: "gpt-5.6-luna",
    });
    expect(req("gpt-5.6-luna")).toMatchObject({ model: "gpt-5.6-luna" });
    expect(req("codecraft:")).toMatchObject({
      error: "A model must be selected for the custom provider.",
    });
  });

  it("anthropic message shaping merges consecutive same-role turns", () => {
    const convo: OpenRouterMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
    ];
    const req = buildByokStreamRequest(mk("anthropic"), convo);
    const msgs = req.body.messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((msgs[2].content as any[]).length).toBe(2);
  });
});
