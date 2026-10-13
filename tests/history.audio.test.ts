/// <reference types="jest" />
jest.mock("../src/lib/prisma", () => ({ prisma: {} }));
import { AUDIO_LISTEN_MARKER, buildHistoryMessages } from "../src/modules/chat/history";
import { audioDataUrlOf, audioMissingBytes } from "../src/lib/fileAttachments";

const audioRow = (id: string, content: string, dataUrl: string | null) => ({
  id,
  role: "USER",
  content,
  status: "COMPLETE",
  files: [
    {
      name: "clip.mp3",
      mime: "audio/mpeg",
      size: 124000,
      content: "[audio file: clip.mp3 (audio/mpeg, 121KB)]",
      ...(dataUrl ? { dataUrl } : {}),
    },
  ],
});

describe("history native audio", () => {
  it("emits input_audio parts for the latest audio turn", () => {
    const { messages, stats } = buildHistoryMessages(
      [audioRow("u1", "Listen carefully", "data:audio/mpeg;base64,AAA")],
      {}
    );
    const user = messages.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = (user?.content ?? []) as Array<{ type?: string; input_audio?: { data?: string; format?: string } }>;
    const audio = parts.find((p) => p.type === "input_audio");
    expect(audio?.input_audio?.data).toBe("AAA");
    expect(audio?.input_audio?.format).toBe("mp3");
    expect(stats.audioCount).toBe(1);
  });

  it("binds the listen-or-report marker to the audio turn text", () => {
    const { messages } = buildHistoryMessages(
      [audioRow("u1", "Listen carefully", "data:audio/mpeg;base64,AAA")],
      {}
    );
    const user = messages.find((m) => m.role === "user");
    const text = (Array.isArray(user?.content) ? user.content : []).find(
      (p: { type?: string }) => p.type === "text"
    ) as { text: string };
    expect(text.text).toContain("Listen carefully");
    expect(text.text).toContain(AUDIO_LISTEN_MARKER);
    expect(text.text).toContain("[NO AUDIO RECEIVED]");
  });

  it("image-only turns carry no audio marker", () => {
    const { messages } = buildHistoryMessages(
      [{ id: "u1", role: "USER", content: "look", status: "COMPLETE", images: ["data:image/png;base64,AAA"] }],
      {}
    );
    const user = messages.find((m) => m.role === "user");
    const text = (Array.isArray(user?.content) ? user.content : []).find(
      (p: { type?: string }) => p.type === "text"
    ) as { text: string };
    expect(text.text).not.toContain("[NO AUDIO RECEIVED]");
  });

  it("drops older audio, keeps only the latest turn's bytes", () => {
    const { messages, stats } = buildHistoryMessages(
      [
        audioRow("u1", "first clip", "data:audio/mpeg;base64,AAA"),
        { id: "a1", role: "ASSISTANT", content: "ok", status: "COMPLETE" },
        audioRow("u2", "second clip", "data:audio/wav;base64,BBB"),
      ],
      {}
    );
    const audios = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((p: { type?: string }) => p.type === "input_audio") : []
    );
    expect(audios).toHaveLength(1);
    expect((audios[0] as { input_audio: { data: string; format: string } }).input_audio.data).toBe("BBB");
    expect(stats.droppedAudio).toBe(1);
  });

  it("audio-only turn with empty text still sends audio", () => {
    const { messages } = buildHistoryMessages(
      [audioRow("u1", "", "data:audio/mpeg;base64,AAA")],
      {}
    );
    const user = messages.find((m) => m.role === "user");
    expect(Array.isArray(user?.content)).toBe(true);
  });
});

describe("audioMissingBytes", () => {
  const withBytes = [{ name: "c.mp3", mime: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,AAA" }];
  const withoutBytes = [{ name: "c.mp3", mime: "audio/mpeg" }];
  it("fails only when bytes are missing and no transcript exists", () => {
    expect(audioMissingBytes(withBytes, "listen")).toEqual([]);
    expect(audioMissingBytes(withoutBytes, "listen")).toEqual(["c.mp3"]);
    // Legacy transcribed rows still answer from their text.
    expect(audioMissingBytes(withoutBytes, "[transcribed audio]: hello")).toEqual([]);
    expect(audioMissingBytes([], "listen")).toEqual([]);
    expect(audioMissingBytes(undefined, "listen")).toEqual([]);
  });
});
describe("audioDataUrlOf", () => {
  it("accepts audio data URLs within cap", () => {
    expect(audioDataUrlOf({ mime: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,AAA" })).toBe(
      "data:audio/mpeg;base64,AAA"
    );
  });
  it("rejects non-audio or oversized payloads", () => {
    expect(audioDataUrlOf({ mime: "text/plain", dataUrl: "data:audio/mpeg;base64,AAA" })).toBeNull();
    expect(audioDataUrlOf({ mime: "audio/mpeg", dataUrl: "data:image/png;base64,AAA" })).toBeNull();
    expect(audioDataUrlOf({ mime: "audio/mpeg" })).toBeNull();
  });
});
