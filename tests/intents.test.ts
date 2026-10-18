/// <reference types="jest" />
import { wantsImageGeneration, wantsVideo } from "../src/modules/chat/intents";
import { wantsWebSearch, wantsSearchImages } from "../src/lib/websearch";

describe("universal search: plus-button or explicit search triggers for every provider", () => {
  const shouldTriggerSearch = (opts: { webSearch?: boolean; raw: string; hasDoc: boolean; research?: boolean }): boolean => {
    const { webSearch, raw, hasDoc, research } = opts;
    return webSearch === true || wantsWebSearch(raw) || (!hasDoc && research === true);
  };

  it("explicit search keyword bypasses hasDoc (even with attached doc)", () => {
    expect(shouldTriggerSearch({ webSearch: false, raw: "search for latest prices inside pdf", hasDoc: true, research: false })).toBe(true);
    expect(shouldTriggerSearch({ webSearch: false, raw: "search image of cats", hasDoc: true, research: false })).toBe(true);
  });

  it("plus-button armed (webSearch true) triggers even without keyword and with hasDoc", () => {
    expect(shouldTriggerSearch({ webSearch: true, raw: "explain this document", hasDoc: true })).toBe(true);
    expect(shouldTriggerSearch({ webSearch: true, raw: "hello", hasDoc: false })).toBe(true);
  });

  it("auto search without toggle only via intent, blocked by hasDoc unless explicit", () => {
    expect(shouldTriggerSearch({ webSearch: false, raw: "write a poem", hasDoc: false })).toBe(false);
    expect(shouldTriggerSearch({ webSearch: false, raw: "latest news today", hasDoc: false })).toBe(true);
    expect(shouldTriggerSearch({ webSearch: false, raw: "latest news today", hasDoc: true })).toBe(false);
    expect(shouldTriggerSearch({ webSearch: false, raw: "search latest news today", hasDoc: true })).toBe(true);
  });

  it("research without explicit search still respects hasDoc", () => {
    expect(shouldTriggerSearch({ webSearch: false, raw: "explain quantum", hasDoc: false, research: true })).toBe(true);
    expect(shouldTriggerSearch({ webSearch: false, raw: "explain quantum", hasDoc: true, research: true })).toBe(false);
  });

  it("works for any provider id — provider-agnostic (no registry check)", () => {
    const providers = ["openrouter", "openai", "google", "anthropic", "future-provider", "my-custom-llm"];
    for (const pid of providers) {
      expect(shouldTriggerSearch({ webSearch: true, raw: "anything", hasDoc: true })).toBe(true);
      expect(shouldTriggerSearch({ webSearch: false, raw: "search cats", hasDoc: false })).toBe(true);
      void pid;
    }
  });
});

describe("search image vs create image are strictly different", () => {
  it("search image does NOT allocate image generation", () => {
    expect(wantsImageGeneration("search image of cats")).toBe(false);
    expect(wantsImageGeneration("search for images of dogs")).toBe(false);
    expect(wantsImageGeneration("search pics of mountains")).toBe(false);
    expect(wantsImageGeneration("find images of sunset")).toBe(false);
    expect(wantsImageGeneration("search image cats cute")).toBe(false);
  });

  it("search image is a web search with image enrichment", () => {
    expect(wantsWebSearch("search image of cats")).toBe(true);
    expect(wantsSearchImages("search image of cats")).toBe(true);
    expect(wantsWebSearch("search pics of mountains")).toBe(true);
    expect(wantsSearchImages("search pics of mountains")).toBe(true);
  });

  it("create/generate image allocates image generation (no search)", () => {
    expect(wantsImageGeneration("create image of cats")).toBe(true);
    expect(wantsImageGeneration("generate an image of a sunset")).toBe(true);
    expect(wantsImageGeneration("draw me a logo for a coffee shop")).toBe(true);
    expect(wantsImageGeneration("design a wallpaper of mountains")).toBe(true);
    expect(wantsImageGeneration("image of a cat")).toBe(true);
  });

  it("create image does not imply search unless explicitly typed", () => {
    expect(wantsWebSearch("create image of cats")).toBe(false);
  });

  it("search video does NOT allocate video generation", () => {
    expect(wantsVideo("search video of cats")).toBe(false);
    expect(wantsVideo("search for videos of dogs")).toBe(false);
  });

  it("create video allocates video generation", () => {
    expect(wantsVideo("create video of cats")).toBe(true);
    expect(wantsVideo("generate a video of a sunset")).toBe(true);
    expect(wantsVideo("video of a cat")).toBe(true);
  });
});
