// Brave search integration: intent detection + llm/context mapping.
/// <reference types="jest" />
import { env } from "../src/lib/config";
import { enrichWithImages, extractOgImage, hasAttachedDocument, stageLineForSource, wantsWebSearch, wantsSearchImages, wantsYouTubeSearch, youTubeVideoIdFromUrl } from "../src/lib/websearch";
import { performWebSearch } from "../src/lib/websearch";
import { performWebSearchWithProvider } from "../src/lib/websearch";
import { ensureSingleSourcesSection } from "../src/lib/websearch";
import { clampSearchDepth, isSearchProvider, providerOrder, researchSearchDepth, resolveSearchDepth, resolveSearchProvider } from "../src/lib/searchSettings";
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

describe("hasAttachedDocument", () => {
  it.each([
    "[PDF: report.pdf]\nunderstand this pdf, latest prices inside",
    "summarize this\n[file: notes.txt (text/plain, 2KB)]\nwhat happened in 2024",
    "[audio file: clip.mp3 (audio/mpeg, 100KB)]\n[transcribed audio]: current news discussion",
    "extract the pdf [PDF: scan.pdf (120KB) — binary PDF, text could not be extracted here]",
    "[video file: clip.mp4 (video/mp4, 1200KB)]\nwhat is happening in this video today",
  ])("detects %p", (q) => expect(hasAttachedDocument(q)).toBe(true));

  it.each([
    "search for the best phone",
    "summarize this article https://example.com/piece",
    "",
  ])("ignores %p", (q) => expect(hasAttachedDocument(q)).toBe(false));
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

describe("ensureSingleSourcesSection", () => {
  const sources = [
    { title: "The Kathmandu Post", url: "https://kathmandupost.com" },
    { title: "Nepal News", url: "https://english.nepalnews.com" },
  ];

  it("swaps a model-written titles-only section for the canonical URL list", () => {
    const body =
      "Here is the news.\n\nSources\nThe Kathmandu Post\nNepal News\nmyRepublica";
    const out = ensureSingleSourcesSection(body, sources);
    expect(out).toContain("Here is the news.");
    expect(out).toContain("https://kathmandupost.com");
    expect(out).toContain("https://english.nepalnews.com");
    expect(out.match(/^Sources:$/gim)).toHaveLength(1);
    expect(out).not.toContain("myRepublica");
  });

  it("handles **Sources:** and ## References headings", () => {
    const out = ensureSingleSourcesSection(
      "Answer.\n\n**Sources:**\n- Item one\n- Item two",
      sources
    );
    expect(out.match(/sources:/gi)).toHaveLength(1);
    expect(out).toContain("https://kathmandupost.com");
  });

  it("appends the footer when the model wrote no section", () => {
    const out = ensureSingleSourcesSection("Just an answer.", sources);
    expect(out).toContain("Just an answer.");
    expect(out).toContain("Sources:");
    expect(out).toContain("https://kathmandupost.com");
  });

  it("leaves prose after a mid-text heading alone", () => {
    const body = "My sources are many. Sources of income include salary and rent which pay monthly.";
    const out = ensureSingleSourcesSection(body, sources);
    expect(out).toContain("My sources are many.");
  });

  it("appendIfMissing=false only swaps, never appends", () => {
    expect(ensureSingleSourcesSection("Just an answer.", sources, false)).toBe("Just an answer.");
    const swapped = ensureSingleSourcesSection("Answer.\n\nSources:\n- Old item", sources, false);
    expect(swapped).toContain("https://kathmandupost.com");
    expect(swapped).not.toContain("Old item");
  });
});

describe("performWebSearch via YouTube", () => {
  const OLD_YT = (env as any).YOUTUBE_API_KEY;
  afterEach(() => {
    jest.restoreAllMocks();
    (env as any).YOUTUBE_API_KEY = OLD_YT;
  });

  it("queries the Data API and maps videos to watch URLs", async () => {
    (env as any).YOUTUBE_API_KEY = "test-yt-key";
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: { videoId: "abc123" },
            snippet: { title: "Cool video", description: "Desc here", channelTitle: "Chan" },
          },
          { id: {}, snippet: {} },
        ],
      }),
    });
    const hits = await performWebSearch("funny cats", 5, "youtube");
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe("https://www.youtube.com/watch?v=abc123");
    expect(hits[0].title).toBe("Cool video");
    expect(hits[0].snippet).toContain("Chan");
    const calls = ((global as any).fetch as jest.Mock).mock.calls;
    expect(calls[0][0]).toContain("www.googleapis.com/youtube/v3/search");
    expect(calls[0][0]).toContain("key=test-yt-key");
  });

  it("auto-routes video intent to YouTube", async () => {
    (env as any).YOUTUBE_API_KEY = "test-yt-key";
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: { videoId: "v1" }, snippet: { title: "T", description: "D" } }],
      }),
    });
    const hits = await performWebSearch("watch the match trailer", 5, "auto");
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toContain("youtube.com/watch");
  });

  it("detects video intent without catching generation prompts", () => {
    expect(wantsYouTubeSearch("watch the finals highlights")).toBe(true);
    expect(wantsYouTubeSearch("best nepali song")).toBe(true);
    expect(wantsYouTubeSearch("movie trailer")).toBe(true);
    expect(wantsYouTubeSearch("generate a video of a sunset")).toBe(false);
    expect(wantsYouTubeSearch("search today news")).toBe(false);
  });
});

describe("result photos", () => {
  afterEach(() => jest.restoreAllMocks());

  it("extracts og:image and resolves relative urls", () => {
    expect(
      extractOgImage(`<meta property="og:image" content="https://cdn.example/p.jpg">`, "https://a.com/x")
    ).toBe("https://cdn.example/p.jpg");
    expect(
      extractOgImage(`<meta name="twitter:image" content="/img/t.png">`, "https://a.com/x")
    ).toBe("https://a.com/img/t.png");
    expect(extractOgImage(`<meta property="og:title" content="nope">`, "https://a.com")).toBeNull();
    expect(extractOgImage(`<meta property="og:image" content="data:image/png;base64,xx">`, "https://a.com")).toBeNull();
  });

  it("uses YouTube thumbnails without fetching", async () => {
    (global as any).fetch = jest.fn(() => {
      throw new Error("must not fetch");
    });
    const out = await enrichWithImages([
      { title: "V", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", snippet: "" },
    ]);
    expect(out[0].image).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  });

  it("attaches og:image from result pages, keeps misses imageless", async () => {
    (global as any).fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).includes("with-photo")) {
        return {
          ok: true,
          headers: { get: () => "text/html" },
          text: async () => `<meta property="og:image" content="https://cdn.example/1.jpg">`,
        };
      }
      return { ok: false, headers: { get: () => null }, text: async () => "" };
    });
    const out = await enrichWithImages([
      { title: "A", url: "https://with-photo.example/a", snippet: "" },
      { title: "B", url: "https://plain.example/b", snippet: "" },
    ]);
    expect(out[0].image).toBe("https://cdn.example/1.jpg");
    expect(out[1].image).toBeUndefined();
  });

  it("parses youtube ids for thumbnails", () => {
    expect(youTubeVideoIdFromUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoIdFromUrl("https://www.youtube.com/shorts/abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youTubeVideoIdFromUrl("https://example.com")).toBeNull();
  });
});

describe("providerOrder / resolveSearchProvider", () => {
  it("orders explicit picks first, auto keeps Brave first", () => {
    expect(providerOrder("auto")).toEqual(["brave", "exa", "duckduckgo"]);
    expect(providerOrder("exa")).toEqual(["exa", "brave", "duckduckgo"]);
    expect(providerOrder("youtube")).toEqual(["youtube", "brave", "exa", "duckduckgo"]);
    expect(providerOrder("duckduckgo")).toEqual(["duckduckgo", "brave", "exa"]);
    expect(isSearchProvider("exa")).toBe(true);
    expect(isSearchProvider("youtube")).toBe(true);
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

describe("resolveSearchDepth", () => {
  it("clamps into 3..20, defaulting to 5", () => {
    expect(clampSearchDepth(10)).toBe(10);
    expect(clampSearchDepth(3)).toBe(3);
    expect(clampSearchDepth(20)).toBe(20);
    expect(clampSearchDepth(1)).toBe(3);
    expect(clampSearchDepth(100)).toBe(20);
    expect(clampSearchDepth(undefined)).toBe(5);
    expect(clampSearchDepth("bogus")).toBe(5);
  });

  it("resolves the stored depth, defaulting to 5", async () => {
    const findUnique = prisma.userSettings.findUnique as unknown as jest.Mock;
    findUnique.mockResolvedValue({ userId: "u", searchDepth: 15 });
    await expect(resolveSearchDepth("u")).resolves.toBe(15);
    findUnique.mockResolvedValue({ userId: "u", searchDepth: 99 });
    await expect(resolveSearchDepth("u")).resolves.toBe(20);
    findUnique.mockResolvedValue(null);
    await expect(resolveSearchDepth("u")).resolves.toBe(5);
    await expect(resolveSearchDepth("")).resolves.toBe(5);
  });
});

describe("researchSearchDepth", () => {
  it("scales the user depth into the 20-60 research fan-out", () => {
    expect(researchSearchDepth(5)).toBe(20);
    expect(researchSearchDepth(10)).toBe(30);
    expect(researchSearchDepth(20)).toBe(60);
    expect(researchSearchDepth(undefined)).toBe(20);
  });
});

describe("stageLineForSource", () => {
  it("shows the website URL plus content detail, not host and title", () => {
    const line = stageLineForSource(0, 5, "Prime Minister of Nepal", "https://en.wikipedia.org/wiki/Prime_Minister_of_Nepal", "The prime minister leads the government of Nepal…");
    expect(line).toContain("1/5 https://en.wikipedia.org/wiki/Prime_Minister_of_Nepal");
    expect(line).toContain("The prime minister leads the government");
  });

  it("falls back to the title when no snippet is available", () => {
    const line = stageLineForSource(2, 5, "Some Page", "https://example.com/a");
    expect(line).toContain("3/5 https://example.com/a");
    expect(line).toContain("Some Page");
  });
});

describe("parallel fan-out", () => {
  const OLD_BRAVE = env.BRAVE_API_KEY;
  const OLD_EXA = (env as any).EXA_API_KEY;
  const OLD_YT = (env as any).YOUTUBE_API_KEY;
  afterEach(() => {
    jest.restoreAllMocks();
    (env as any).BRAVE_API_KEY = OLD_BRAVE;
    (env as any).EXA_API_KEY = OLD_EXA;
    (env as any).YOUTUBE_API_KEY = OLD_YT;
  });

  it("queries keyed providers at once, merges by priority with URL dedupe", async () => {
    (env as any).BRAVE_API_KEY = "test-brave-key";
    (env as any).EXA_API_KEY = "test-exa-key";
    (env as any).YOUTUBE_API_KEY = "";
    (global as any).fetch = jest.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("api.search.brave.com")) {
        return {
          ok: true,
          json: async () => ({
            grounding: {
              generic: [
                { url: "https://example.com/a", title: "A", snippets: ["a"] },
                { url: "https://example.com/shared", title: "Shared Brave", snippets: ["s"] },
              ],
            },
          }),
        };
      }
      if (u.includes("api.exa.ai")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              { url: "https://example.com/shared", title: "Shared Exa", highlights: ["h"] },
              { url: "https://example.com/c", title: "C", highlights: [] },
            ],
          }),
        };
      }
      return { ok: false };
    });
    const { hits, provider } = await performWebSearchWithProvider("test query", 10, "auto");
    const urls = hits.map((h) => h.url);
    // Both providers were hit (parallel), shared URL kept once (Brave priority).
    const called = ((global as any).fetch as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
    expect(called.some((u: string) => u.includes("api.search.brave.com"))).toBe(true);
    expect(called.some((u: string) => u.includes("api.exa.ai"))).toBe(true);
    expect(urls).toEqual(["https://example.com/a", "https://example.com/shared", "https://example.com/c"]);
    expect(hits.find((h) => h.url === "https://example.com/shared")?.title).toBe("Shared Brave");
    expect(provider).toBe("brave");
  });
});

describe("wantsSearchImages", () => {
  it.each([
    "show me photos of the new stadium",
    "best wallpaper of mountains",
    "what does it look like",
    "send me pictures of cats",
  ])("enriches %p", (q) => expect(wantsSearchImages(q)).toBe(true));

  it.each([
    "latest prime minister of nepal",
    "current price of bitcoin",
    "who won the match",
    "write a poem about the sea",
    "",
  ])("stays imageless for %p", (q) => expect(wantsSearchImages(q)).toBe(false));
});
