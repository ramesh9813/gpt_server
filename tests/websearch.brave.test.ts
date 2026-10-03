// Brave search integration: intent detection + llm/context mapping.
/// <reference types="jest" />
import { env } from "../src/lib/config";
import { wantsWebSearch } from "../src/lib/websearch";
import { performWebSearch } from "../src/lib/websearch";
import { isSearchProvider, providerOrder, resolveSearchProvider } from "../src/lib/searchSettings";
import { prisma } from "../src/lib/prisma";

jest.mock("../src/lib/prisma", () => ({
  prisma: { userSettings: { findUnique: jest.fn() } },
}));

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

describe("performWebSearch via Exa", () => {
  const OLD_BRAVE = env.BRAVE_API_KEY;
  const OLD_EXA = (env as any).EXA_API_KEY;
  afterEach(() => {
    jest.restoreAllMocks();
    (env as any).BRAVE_API_KEY = OLD_BRAVE;
    (env as any).EXA_API_KEY = OLD_EXA;
  });

  it("posts to api.exa.ai with a Bearer key and maps highlights", async () => {
    (env as any).BRAVE_API_KEY = "";
    (env as any).EXA_API_KEY = "test-exa-key";
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: "E1", url: "https://exa.example/1", highlights: ["h1", "h2"] },
          { title: "E2", url: "https://exa.example/2", text: "full text here" },
        ],
      }),
    });
    const hits = await performWebSearch("test query", 5, "exa");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "E1", url: "https://exa.example/1", snippet: "h1 h2" });
    expect(hits[1].snippet).toBe("full text here");
    const calls = ((global as any).fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toBe("https://api.exa.ai/search");
    expect(calls[0][1].headers.Authorization).toBe("Bearer test-exa-key");
    expect(JSON.parse(calls[0][1].body).query).toBe("test query");
  });

  it("explicit pick falls back when its key is missing", async () => {
    (env as any).BRAVE_API_KEY = "";
    (env as any).EXA_API_KEY = "";
    // DDG html empty -> instant {} -> wikipedia empty
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ query: { search: [] } }) });
    const hits = await performWebSearch("test query", 5, "exa");
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe("providerOrder / resolveSearchProvider", () => {
  it("orders explicit picks first, auto keeps Brave first", () => {
    expect(providerOrder("auto")).toEqual(["brave", "exa", "duckduckgo"]);
    expect(providerOrder("exa")).toEqual(["exa", "brave", "duckduckgo"]);
    expect(providerOrder("duckduckgo")).toEqual(["duckduckgo", "brave", "exa"]);
    expect(isSearchProvider("exa")).toBe(true);
    expect(isSearchProvider("nope")).toBe(false);
  });

  it("resolves the stored pick, defaulting to auto", async () => {
    const findUnique = prisma.userSettings.findUnique as unknown as jest.Mock;
    findUnique.mockResolvedValue({ userId: "u", searchProvider: "exa" });
    await expect(resolveSearchProvider("u")).resolves.toBe("exa");
    findUnique.mockResolvedValue({ userId: "u", searchProvider: "bogus" });
    await expect(resolveSearchProvider("u")).resolves.toBe("auto");
    findUnique.mockResolvedValue(null);
    await expect(resolveSearchProvider("u")).resolves.toBe("auto");
    await expect(resolveSearchProvider("")).resolves.toBe("auto");
  });
});
