// YouTube transcripts: id extraction, intent, caption parsing + picking.
/// <reference types="jest" />
import {
  extractYouTubeVideoId,
  fetchVideoTranscriptFor,
  fetchYouTubeTranscript,
  parseTranscriptXml,
  pickCaptionTrack,
  wantsTranscript,
} from "../src/lib/youtubeTranscript";

describe("extractYouTubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ?feature=share", "dQw4w9WgXcQ"],
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("parses %p", (url, id) => expect(extractYouTubeVideoId(url)).toBe(id));

  it("rejects non-youtube urls", () => {
    expect(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeVideoId("hello world")).toBeNull();
  });
});

describe("wantsTranscript", () => {
  it.each([
    "transcribe this video https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ give me the exact text",
    "what was said in https://youtu.be/dQw4w9WgXcQ",
    "subtitles please https://youtu.be/dQw4w9WgXcQ",
  ])("triggers on %p", (t) => expect(wantsTranscript(t)).toBe(true));

  it.each([
    "watch this https://youtu.be/dQw4w9WgXcQ",
    "transcribe this meeting",
    "search the web",
  ])("stays off for %p", (t) => expect(wantsTranscript(t)).toBe(false));
});

describe("parseTranscriptXml", () => {
  it("parses srv3 text tags", () => {
    const lines = parseTranscriptXml(
      `<transcript><text start="0.5" dur="2.0">Hello &amp; welcome</text><text start="2.5" dur="1.5">second <b>line</b></text></transcript>`
    );
    expect(lines).toEqual([
      { text: "Hello & welcome", offsetMs: 500 },
      { text: "second line", offsetMs: 2500 },
    ]);
  });
  it("falls back to p tags", () => {
    const lines = parseTranscriptXml(`<transcript><p t="1000" d="500">Hi there</p></transcript>`);
    expect(lines).toEqual([{ text: "Hi there", offsetMs: 1000 }]);
  });
  it("returns [] for garbage", () => {
    expect(parseTranscriptXml("<html>nope</html>")).toEqual([]);
  });
});

describe("pickCaptionTrack", () => {
  const tracks = [
    { baseUrl: "u-es", languageCode: "es" },
    { baseUrl: "u-en-asr", languageCode: "en", kind: "asr" },
    { baseUrl: "u-en", languageCode: "en" },
  ];
  it("prefers manual over auto captions", () => {
    expect(pickCaptionTrack(tracks, "en")?.baseUrl).toBe("u-en");
  });
  it("falls back across languages", () => {
    expect(pickCaptionTrack(tracks, "fr")?.baseUrl).toBe("u-es");
  });
  it("returns null when empty", () => {
    expect(pickCaptionTrack([], "en")).toBeNull();
  });
});

describe("fetchYouTubeTranscript", () => {
  afterEach(() => jest.restoreAllMocks());

  const player = (overrides: any = {}) => ({
    videoDetails: { title: "Test Video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{ baseUrl: "https://caps.example/t", languageCode: "en" }],
      },
    },
    ...overrides,
  });

  it("returns exact text from captions", async () => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => player() })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `<transcript><text start="0" dur="1">first words</text><text start="1" dur="1">more words</text></transcript>`,
      });
    const tr = await fetchYouTubeTranscript("dQw4w9WgXcQ");
    expect(tr?.title).toBe("Test Video");
    expect(tr?.text).toBe("first words more words");
    expect(tr?.lines).toHaveLength(2);
    const playerCall = ((global as any).fetch as jest.Mock).mock.calls[0];
    expect(playerCall[0]).toContain("youtubei/v1/player");
    expect(JSON.parse(playerCall[1].body).videoId).toBe("dQw4w9WgXcQ");
  });

  it("returns null with no captions or bad status", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => player({ captions: {}, playabilityStatus: { status: "ERROR", reason: "gone" } }),
    });
    await expect(fetchYouTubeTranscript("dQw4w9WgXcQ")).resolves.toBeNull();
  });
});

describe("fetchVideoTranscriptFor", () => {
  afterEach(() => jest.restoreAllMocks());

  it("builds a context block with video source", async () => {
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          videoDetails: { title: "V" },
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{ baseUrl: "https://caps.example/t", languageCode: "en" }],
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `<transcript><text start="0" dur="1">hello video</text></transcript>`,
      });
    const out = await fetchVideoTranscriptFor("transcribe https://youtu.be/dQw4w9WgXcQ");
    expect(out?.sources).toEqual([{ title: "V", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
    expect(out?.block).toContain("hello video");
    expect(out?.lines).toBe(1);
  });

  it("returns null without transcribe intent", async () => {
    await expect(fetchVideoTranscriptFor("watch https://youtu.be/dQw4w9WgXcQ")).resolves.toBeNull();
  });
});
