// Direct page fetch: pasted URLs are read themselves, not searched.
/// <reference types="jest" />
import { extractPageUrls, fetchLinkedPages, wantsPageDetail } from "../src/lib/pageContent";

describe("extractPageUrls", () => {
  it("finds urls and blocks private hosts", () => {
    expect(extractPageUrls("read https://example.com/a and http://localhost:3000/x")).toEqual([
      "https://example.com/a",
    ]);
    expect(extractPageUrls("see http://169.254.169.254/latest and https://a.com")).toEqual([
      "https://a.com",
    ]);
    expect(extractPageUrls("no links here")).toEqual([]);
  });
  it("caps at 3 urls and dedupes", () => {
    const text = "https://a.com https://b.com https://a.com https://c.com https://d.com";
    expect(extractPageUrls(text)).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });
});

describe("wantsPageDetail", () => {
  it.each([
    "https://example.com/article detailize this",
    "detail this page https://example.com/a",
    "summarize this link https://example.com/a",
    "what is in this https://example.com/a",
    "https://example.com/a",
  ])("triggers on %p", (t) => expect(wantsPageDetail(t)).toBe(true));

  it.each([
    "search the web for cats",
    "what is the capital of Peru",
    "read a book about history",
    "",
  ])("stays off for %p", (t) => expect(wantsPageDetail(t)).toBe(false));
});

describe("fetchLinkedPages", () => {
  afterEach(() => jest.restoreAllMocks());

  it("fetches the page and builds a context block with sources", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () =>
        `<html><head><title>Test Page</title></head><body><script>var x=1;</script><article><h1>Hi</h1><p>Body text here.</p></article></body></html>`,
    });
    const out = await fetchLinkedPages("detail this https://example.com/a");
    expect(out).not.toBeNull();
    expect(out!.sources).toEqual([{ title: "Test Page", url: "https://example.com/a" }]);
    expect(out!.block).toContain("Body text here.");
    expect(out!.block).not.toContain("var x=1");
  });

  it("returns null when nothing is readable", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null }, text: async () => "" });
    await expect(fetchLinkedPages("detail https://example.com/a")).resolves.toBeNull();
  });

  it("returns null without urls (no fetch attempted)", async () => {
    (global as any).fetch = jest.fn(() => {
      throw new Error("must not fetch");
    });
    await expect(fetchLinkedPages("search the web")).resolves.toBeNull();
  });
});
