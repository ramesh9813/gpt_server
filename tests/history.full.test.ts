/// <reference types="jest" />
// Full-history guarantees: nothing is trimmed, compacted or dropped anymore.
jest.mock("../src/lib/prisma", () => ({ prisma: {} }));
import { buildHistoryMessages, DEFAULT_RECENT_KEEP } from "../src/modules/chat/history";
import { streamSchema } from "../src/modules/chat/chat.service";
import { pdfDataUrlOf, pdfMissingBytes } from "../src/lib/fileAttachments";

const pdfUrl = (n = 8) => `data:application/pdf;base64,${"JUIFUkVDSUZFUi8+".repeat(n)}`;

const long = (n: number) => "x".repeat(n);
const img = (n: number) => `data:image/png;base64,${"A".repeat(n)}`;

describe("buildHistoryMessages sends the full history", () => {
  it("passes long messages through untruncated", () => {
    const big = long(5000);
    const { messages, stats } = buildHistoryMessages(
      [
        { id: "u1", role: "USER", content: big, status: "COMPLETE" },
        { id: "a1", role: "ASSISTANT", content: big, status: "COMPLETE" },
      ],
      {}
    );
    const userMsg = messages.find((m) => m.role === "user" && m.content === big);
    expect(userMsg).toBeTruthy();
    expect(messages.some((m) => m.content === big)).toBe(true);
    expect(stats.truncated).toBe(0);
    expect(JSON.stringify(messages)).not.toContain("[truncated");
  });

  it("keeps every message regardless of total size", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "USER" : "ASSISTANT",
      content: long(5000),
      status: "COMPLETE",
    }));
    const { messages } = buildHistoryMessages(rows, {});
    const textMsgs = messages.filter((m) => m.role !== "system" && m.content === long(5000));
    expect(textMsgs.length).toBe(40);
  });

  it("adds the first-user-message seed anchor only past the recent-keep window", () => {
    const seed = "What is the capital of France?";
    const many = Array.from({ length: DEFAULT_RECENT_KEEP + 3 }, (_, i) => ({
      id: `m${i}`,
      role: i === 0 ? "USER" : i % 2 === 0 ? "USER" : "ASSISTANT",
      content: i === 0 ? seed : `Message number ${i}`,
      status: "COMPLETE",
    }));
    const withAnchor = buildHistoryMessages(many, { systemPrompt: "Be helpful." });
    const anchor = withAnchor.messages.find(
      (m) => m.role === "user" && m.content === seed.slice(0, 200)
    );
    expect(anchor).toBeTruthy();
    expect(withAnchor.messages[0].role).toBe("system");

    const few = many.slice(0, DEFAULT_RECENT_KEEP);
    const withoutAnchor = buildHistoryMessages(few, { systemPrompt: "Be helpful." });
    expect(
      withoutAnchor.messages.filter((m) => m.role === "user" && m.content === seed)
    ).toHaveLength(1);
  });

  it("keeps image bytes only on the LAST image-bearing user row", () => {
    const rows = [
      { id: "u1", role: "USER", content: "first pic", images: [img(10)], status: "COMPLETE" },
      { id: "a1", role: "ASSISTANT", content: "nice", status: "COMPLETE" },
      { id: "u2", role: "USER", content: "second pic", images: [img(20)], status: "COMPLETE" },
    ];
    const { messages, stats } = buildHistoryMessages(rows, {});
    const firstJson = JSON.stringify(
      messages.find((m) => JSON.stringify(m).includes("first pic")) ?? {}
    );
    expect(firstJson).not.toContain("image_url");
    expect(firstJson).toContain("[earlier attached image omitted]");
    const lastJson = JSON.stringify(
      messages.find((m) => JSON.stringify(m).includes("second pic")) ?? {}
    );
    expect(lastJson).toContain("image_url");
    expect(stats.droppedImages).toBe(1);
  });

  it("summarizes quiz rows instead of dropping them", () => {
    const quiz = { round: 2, topic: "cells", questions: [{ question: "Mitochondria?" }] };
    const { messages } = buildHistoryMessages(
      [
        { id: "q1", role: "ASSISTANT", content: "", quiz, status: "COMPLETE" },
      ],
      {}
    );
    const text = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(text).toContain('Quiz R2 "cells"');
  });

  it("marks generated media on assistant rows and skips empty streaming shells", () => {
    const { messages } = buildHistoryMessages(
      [
        { id: "g1", role: "ASSISTANT", content: "a cat on a sofa", images: [img(5)], status: "COMPLETE" },
        { id: "s1", role: "ASSISTANT", content: "", status: "STREAMING" },
        { id: "u9", role: "USER", content: "hello", status: "COMPLETE" },
      ],
      {}
    );
    const text = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(text).toContain('[generated image for "a cat on a sofa"]');
    expect(text).toContain("hello");
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });
});

describe("native PDF documents", () => {
  const pdfRow = (id: string, text: string) => ({
    id,
    role: "USER",
    content: `[PDF: ${text}.pdf (12KB) — attached as the original document; read the attached file natively]`,
    status: "COMPLETE",
    files: [{ name: `${text}.pdf`, mime: "application/pdf", size: 12_288, content: "meta", dataUrl: pdfUrl() }],
  });

  it("attaches the original bytes as a file part on the latest pdf turn", () => {
    const { messages } = buildHistoryMessages([pdfRow("u1", "invoice")], {});
    const turn = messages.find((m) => Array.isArray((m as { content?: unknown }).content) && JSON.stringify(m).includes("file_data")) as
      | { content: Array<Record<string, unknown>> }
      | undefined;
    expect(turn).toBeTruthy();
    const filePart = turn!.content.find((p) => p.type === "file") as { file: { filename: string; file_data: string } };
    expect(filePart.file.filename).toBe("invoice.pdf");
    expect(filePart.file.file_data).toBe(pdfUrl());
  });

  it("keeps bytes only on the LAST pdf turn and marks earlier ones", () => {
    const { messages, stats } = buildHistoryMessages(
      [pdfRow("u1", "old"), { id: "a1", role: "ASSISTANT", content: "got it", status: "COMPLETE" }, pdfRow("u2", "new")],
      {}
    );
    const json = messages.map((m) => JSON.stringify(m));
    expect(json.filter((j) => j.includes("file_data"))).toHaveLength(1);
    expect(json.some((j) => j.includes("old.pdf") && j.includes("[earlier attached pdf omitted]"))).toBe(true);
    expect(stats.droppedPdfs).toBe(1);
  });

  it("validates pdf payloads strictly", () => {
    expect(pdfDataUrlOf({ mime: "application/pdf", dataUrl: pdfUrl() })).toBe(pdfUrl());
    expect(pdfDataUrlOf({ mime: "application/pdf", dataUrl: "data:text/plain;base64,AAA" })).toBeNull();
    expect(pdfDataUrlOf({ mime: "text/plain", dataUrl: pdfUrl() })).toBeNull();
    expect(pdfDataUrlOf({ mime: "application/pdf" })).toBeNull();
  });

  it("flags byteless pdfs that promised native bytes, ignores intentional meta notes", () => {
    const promised = { name: "a.pdf", mime: "application/pdf", content: "[PDF: a.pdf — attached as the original document; read the attached file natively]" };
    const intentional = { name: "b.pdf", mime: "application/pdf", content: "[PDF: b.pdf — over the 10MB native-attach limit, contents not sent]" };
    expect(pdfMissingBytes([promised])).toEqual(["a.pdf"]);
    expect(pdfMissingBytes([intentional])).toEqual([]);
    expect(pdfMissingBytes([{ ...promised, dataUrl: pdfUrl() }])).toEqual([]);
  });
});

describe("the trim engine is gone for good", () => {
  it("no longer exports resolveHistoryBudget or a charBudget option", async () => {
    const mod = (await import("../src/modules/chat/history")) as unknown as Record<string, unknown>;
    expect(mod.resolveHistoryBudget).toBeUndefined();
    expect(mod.DEFAULT_CHAR_BUDGET).toBeUndefined();
  });

  it("streamSchema strips the removed promptOnly flag instead of failing old clients", () => {
    const parsed = streamSchema.safeParse({ conversationId: "c1", userMessage: "hi", promptOnly: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).promptOnly).toBeUndefined();
    }
    expect(streamSchema.safeParse({ conversationId: "c1", userMessage: "hi" }).success).toBe(true);
    expect(streamSchema.safeParse({ conversationId: "c1" }).success).toBe(false);
  });
});
