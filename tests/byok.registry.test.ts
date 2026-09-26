// Pure registry tests — no app/DB imports, runnable in any environment.
import {
  BYOK_PROVIDERS,
  getByokProvider,
  isByokKeyFormatSupported,
} from "../src/lib/byok";

describe("byok provider registry", () => {
  it("exposes all six providers", () => {
    expect(Object.keys(BYOK_PROVIDERS).sort()).toEqual([
      "google",
      "grok",
      "meta",
      "nvidia",
      "openai",
      "openrouter",
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
    expect(isByokKeyFormatSupported(google, "AIzaSy" + "b".repeat(33))).toBe(true);
    expect(isByokKeyFormatSupported(google, "sk-" + "a".repeat(48))).toBe(false);

    const grok = getByokProvider("grok")!;
    expect(isByokKeyFormatSupported(grok, "xai-" + "c".repeat(80))).toBe(true);
    expect(isByokKeyFormatSupported(grok, "sk-" + "a".repeat(48))).toBe(false);

    const nvidia = getByokProvider("nvidia")!;
    expect(isByokKeyFormatSupported(nvidia, "nvapi-" + "d".repeat(40))).toBe(true);

    const meta = getByokProvider("meta")!;
    expect(isByokKeyFormatSupported(meta, "LLM|1234567890|abcdef")).toBe(true);
  });
});
