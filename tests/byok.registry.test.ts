// Pure registry tests — no app/DB imports, runnable in any environment.
import {
  BYOK_PROVIDERS,
  getByokProvider,
  isByokKeyFormatSupported,
} from "../src/lib/byok";

describe("byok provider registry", () => {
  it("exposes all twelve providers", () => {
    expect(Object.keys(BYOK_PROVIDERS).sort()).toEqual([
      "anthropic",
      "deepseek",
      "google",
      "grok",
      "groq",
      "meta",
      "mistral",
      "moonshot",
      "nvidia",
      "openai",
      "openrouter",
      "qwen",
    ]);
  });

  it("resolves providers case-insensitively and rejects unknown ids", () => {
    expect(getByokProvider("OpenAI")?.id).toBe("openai");
    expect(getByokProvider("nvidia")?.id).toBe("nvidia");
    expect(getByokProvider("OpenRouter")?.id).toBe("openrouter");
    expect(getByokProvider("acme")).toBeNull();
    expect(getByokProvider(undefined)).toBeNull();
  });

  it("marks keyless-model providers (OpenRouter, NVIDIA) only", () => {
    expect(BYOK_PROVIDERS.openrouter.keylessModels).toBe(true);
    expect(BYOK_PROVIDERS.nvidia.keylessModels).toBe(true);
    expect(BYOK_PROVIDERS.openai.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.google.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.grok.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.meta.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.deepseek.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.qwen.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.moonshot.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.groq.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.mistral.keylessModels).toBe(false);
    expect(BYOK_PROVIDERS.anthropic.keylessModels).toBe(false);
  });

  it("checks key formats per provider", () => {
    const openai = getByokProvider("openai")!;
    expect(isByokKeyFormatSupported(openai, "sk-" + "a".repeat(48))).toBe(true);
    expect(isByokKeyFormatSupported(openai, "AIzaSy" + "b".repeat(33))).toBe(false);
    expect(isByokKeyFormatSupported(openai, "hello")).toBe(false);

    const openrouter = getByokProvider("openrouter")!;
    expect(isByokKeyFormatSupported(openrouter, "sk-or-" + "v".repeat(60))).toBe(true);
    expect(isByokKeyFormatSupported(openrouter, "sk-" + "a".repeat(48))).toBe(false);

    const google = getByokProvider("google")!;
    // Legacy AIza… keys:
    expect(isByokKeyFormatSupported(google, "AIzaSy" + "b".repeat(33))).toBe(true);
    // New AI Studio keys (dot-containing, e.g. "AQ.…"):
    expect(isByokKeyFormatSupported(google, "AQ.Ab8RN6LN5caAL0vB" + "x".repeat(10))).toBe(true);
    // Too-short junk is still rejected:
    expect(isByokKeyFormatSupported(google, "nope")).toBe(false);

    const grok = getByokProvider("grok")!;
    expect(isByokKeyFormatSupported(grok, "xai-" + "c".repeat(80))).toBe(true);
    expect(isByokKeyFormatSupported(grok, "sk-" + "a".repeat(48))).toBe(false);

    const nvidia = getByokProvider("nvidia")!;
    expect(isByokKeyFormatSupported(nvidia, "nvapi-" + "d".repeat(40))).toBe(true);

    const meta = getByokProvider("meta")!;
    expect(isByokKeyFormatSupported(meta, "LLM|1234567890|abcdef")).toBe(true);

    const deepseek = getByokProvider("deepseek")!;
    expect(isByokKeyFormatSupported(deepseek, "sk-" + "e".repeat(32))).toBe(true);

    const qwen = getByokProvider("qwen")!;
    expect(isByokKeyFormatSupported(qwen, "sk-" + "f".repeat(32))).toBe(true);

    const moonshot = getByokProvider("moonshot")!;
    expect(isByokKeyFormatSupported(moonshot, "sk-" + "g".repeat(40))).toBe(true);

    const groq = getByokProvider("groq")!;
    expect(isByokKeyFormatSupported(groq, "gsk_" + "h".repeat(52))).toBe(true);
    expect(isByokKeyFormatSupported(groq, "xai-" + "c".repeat(80))).toBe(false);

    const mistral = getByokProvider("mistral")!;
    expect(isByokKeyFormatSupported(mistral, "j".repeat(32))).toBe(true);

    const anthropic = getByokProvider("anthropic")!;
    expect(isByokKeyFormatSupported(anthropic, "sk-ant-" + "k".repeat(40))).toBe(true);
    expect(isByokKeyFormatSupported(anthropic, "sk-" + "a".repeat(48))).toBe(false);
  });
});
