/// <reference types="jest" />
jest.mock("../src/lib/prisma", () => ({ prisma: {} }));
// MCQ conversation context: the quiz generator binds to a full-text
// transcript of the last 20 rows plus newest history image bytes.
import {
  buildMcqContext,
  parseMcqText,
  parseMcqCount,
  wantsMcq,
  DEFAULT_MCQ_COUNT,
  MAX_MCQ_COUNT,
  type McqQuestion,
} from "../src/modules/chat/mcq";

const VALID_Q: McqQuestion = {
  question: "Capital of France?",
  options: ["Paris", "Rome", "Berlin", "Madrid"],
  answerIndex: 0,
  explanation: "Paris is the capital of France.",
};
const VALID_Q_NO_EXPL: McqQuestion = {
  question: "2+2?",
  options: ["3", "4", "5", "6"],
  answerIndex: 1,
};

describe("buildMcqContext", () => {
  it("renders user/assistant lines joined by blank lines", () => {
    const { transcript, historyImages } = buildMcqContext([
      { role: "USER", content: "teach me physics" },
      { role: "ASSISTANT", content: "sure, what first?" },
      { role: "USER", content: "motion" },
    ]);
    expect(transcript).toBe("user: teach me physics\n\nassistant: sure, what first?\n\nuser: motion");
    expect(historyImages).toEqual([]);
  });

  it("keeps full text — a 3000-char message appears whole", () => {
    const long = "x".repeat(3000);
    const { transcript } = buildMcqContext([{ role: "USER", content: long }]);
    expect(transcript).toContain(long);
  });

  it("summarizes quiz rows instead of dropping them (empty content)", () => {
    const quiz = { round: 2, topic: "cells", questions: [{ question: "Powerhouse of the cell?" }] };
    const { transcript } = buildMcqContext([{ role: "ASSISTANT", content: "", quiz }]);
    expect(transcript).toBe('assistant: Quiz R2 "cells": 1 questions (Powerhouse of the cell?)');
  });

  it("marks assistant image/video rows as generated media", () => {
    const { transcript } = buildMcqContext([
      { role: "ASSISTANT", content: "a cat on a sofa", images: ["data:image/png;base64,AAA"] },
      { role: "ASSISTANT", content: "a clip", videos: ["data:video/mp4;base64,BBB"] },
    ]);
    expect(transcript).toContain('[generated image for "a cat on a sofa"]');
    expect(transcript).toContain("[generated video]");
  });

  it("appends the attached-images marker and collects only data:image/ bytes", () => {
    const { transcript, historyImages } = buildMcqContext([
      {
        role: "USER",
        content: "what is this",
        images: ["data:image/png;base64,AAA", "https://cdn.example.com/pic.png"],
      },
      { role: "USER", content: "link only", images: ["https://cdn.example.com/only.png"] },
    ]);
    expect(transcript).toContain("what is this\n[attached 2 image(s)]");
    expect(transcript).toContain("link only\n[attached 1 image(s)]");
    // The https:// row contributes nothing; only the data:image/ URL rides along.
    expect(historyImages).toEqual(["data:image/png;base64,AAA"]);
  });

  it("spends the 5-image byte budget newest rows first", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      role: "USER",
      content: `msg ${i}`,
      images: [`data:image/png;base64,IMG${i}`],
    }));
    const { historyImages } = buildMcqContext(rows);
    expect(historyImages).toEqual([
      "data:image/png;base64,IMG2",
      "data:image/png;base64,IMG3",
      "data:image/png;base64,IMG4",
      "data:image/png;base64,IMG5",
      "data:image/png;base64,IMG6",
    ]);
  });

  it("skips empty rows entirely", () => {
    const { transcript, historyImages } = buildMcqContext([
      { role: "USER", content: "" },
      { role: "ASSISTANT", content: "   " },
      null,
      { role: "USER", content: "kept" },
    ]);
    expect(transcript).toBe("user: kept");
    expect(historyImages).toEqual([]);
  });

  it("windows to the LAST 20 rows — older rows never appear", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ role: "USER", content: `row ${i}` }));
    const { transcript } = buildMcqContext(rows);
    const lines = transcript.split("\n\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("user: row 5");
    expect(lines[19]).toBe("user: row 24");
    expect(transcript).not.toContain("user: row 4");
    expect(transcript).not.toContain("user: row 0");
  });
});

describe("parseMcqText", () => {
  it("parses a valid questions object", () => {
    expect(parseMcqText(JSON.stringify({ questions: [VALID_Q, VALID_Q_NO_EXPL] }))).toEqual([
      VALID_Q,
      VALID_Q_NO_EXPL,
    ]);
  });

  it("parses a valid bare array and code-fenced output", () => {
    expect(parseMcqText(JSON.stringify([VALID_Q]))).toEqual([VALID_Q]);
    expect(parseMcqText("```json\n" + JSON.stringify({ questions: [VALID_Q] }) + "\n```")).toEqual([
      VALID_Q,
    ]);
  });

  it("extracts the object from prose-wrapped output", () => {
    const out = parseMcqText(
      `Sure, here is your quiz! ${JSON.stringify({ questions: [VALID_Q] })} Hope it helps.`,
    );
    expect(out).toEqual([VALID_Q]);
  });

  it("returns null for garbage", () => {
    expect(parseMcqText("this is not json at all")).toBeNull();
    expect(parseMcqText("")).toBeNull();
  });

  it("returns null on schema violations (wrong option count)", () => {
    const three = { question: "pick one?", options: ["a", "b", "c"], answerIndex: 0 };
    expect(parseMcqText(JSON.stringify({ questions: [three] }))).toBeNull();
    expect(parseMcqText(JSON.stringify([three]))).toBeNull();
  });
});

describe("parseMcqCount", () => {
  it("reads a leading number and cleans the topic", () => {
    expect(parseMcqCount("15 photosynthesis")).toEqual({ count: 15, cleanTopic: "photosynthesis" });
  });

  it("reads a trailing '<n> questions' amount", () => {
    expect(parseMcqCount("photosynthesis 5 questions")).toEqual({
      count: 5,
      cleanTopic: "photosynthesis",
    });
  });

  it("defaults to 10 and leaves a numberless topic untouched", () => {
    expect(parseMcqCount("solar system")).toEqual({ count: DEFAULT_MCQ_COUNT, cleanTopic: "solar system" });
  });

  it("caps the count at 50", () => {
    expect(parseMcqCount("500 kings of france").count).toBe(MAX_MCQ_COUNT);
    expect(parseMcqCount("500 kings of france").cleanTopic).toBe("kings of france");
  });
});

describe("wantsMcq", () => {
  it("triggers only on text that STARTS with mcq", () => {
    expect(wantsMcq("mcq solar system")).toBe(true);
    expect(wantsMcq("MCQ next round")).toBe(true);
    expect(wantsMcq("  mcq")).toBe(true);
    expect(wantsMcq("generate mcq quiz")).toBe(false);
    expect(wantsMcq("quiz me on mcq")).toBe(false);
  });
});
