// Brave search integration: intent detection + llm/context mapping.
/// <reference types="jest" />
import { env } from "../src/lib/config";
import { wantsWebSearch } from "../src/lib/websearch";
import { performWebSearch } from "../src/lib/websearch";

describe("wantsWebSearch", () => {
  it.each([
    "search for the best phone",
    "Search the web for recipes",
    "google the error message",
    "look up the capital of Peru",
    "find out who won yesterday",
    "today's news",
    "give me today news",
    "current price of bitcoin",
    "what is the latest iPhone",
    "who won the match",
    "what happened in the election",
  ])("triggers on %p", (q) => expect(wantsWebSearch(q)).toBe(true));

  it.each([
    "write a poem about the sea",
    "fix my current code bug",
    "explain recursion simply",
    "what should I cook today",
    "summarize this article",
    "",
  ])("stays off for %p", (q) => expect(wantsWebSearch(q)).toBe(false));
});

describe("performWebSearch via Brave", () => {
  const OLD_KEY = env.BRAVE_API_KEY;
  const mockFetch = (json: any, ok = true) =>
    ((global as any).fetch = jest.fn().mockResolvedValue({
      ok,
      json: async () => json,
    }));
  afterEach(() => {
    jest.restoreAllMocks();
    (env as any).BRAVE_API_KEY = OLD_KEY;
  });

  it("maps llm/context grounding to results with references", async () => {
    (env as any).BRAVE_API_KEY = "test-brave-key";
    mockFetch({
      grounding: {
        generic: [
          { url: "https://example.com/a", title: "A", snippets: ["first", "second"] },
          { url: "https://example.com/b", title: "B", snippets: [] },
          { url: "not-a-url", title: "C", snippets: ["x"] },
        ],
      },
    });
    const hits = await performWebSearch("test query", 5);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "A", url: "https://example.com/a", snippet: "first second" });
    const calls = ((global as any).fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toContain("api.search.brave.com/res/v1/llm/context");
    expect(calls[0][1].headers["X-Subscription-Token"]).toBe("test-brave-key");
  });

  it("falls back to the keyless chain when Brave fails", async () => {
    (env as any).BRAVE_API_KEY = "test-brave-key";
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ query: { search: [] } }) });
    const hits = await performWebSearch("test query", 5);
    expect(Array.isArray(hits)).toBe(true);
  });
});
