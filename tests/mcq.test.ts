// MCQ quiz helpers: answer spread must hold no matter how the model
// clusters correct positions, and malformed rows pass through untouched.
import { hashQuestion, parseMcqCount, spreadAnswerPositions, type McqQuestion } from "../src/modules/chat/mcq";

const clustered = (n: number): McqQuestion[] =>
  Array.from({ length: n }, (_, i) => ({
    question: `Question ${i + 1}?`,
    options: [`Right ${i}`, `Wrong ${i} a`, `Wrong ${i} b`, `Wrong ${i} c`],
    answerIndex: 0,
  }));

describe("spreadAnswerPositions", () => {
  it("spreads a fully clustered batch across all four positions", () => {
    const out = spreadAnswerPositions(clustered(4), 1);
    expect(new Set(out.map((q) => q.answerIndex))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("keeps the correct option text on the answer index", () => {
    const out = spreadAnswerPositions(clustered(8), 2);
    out.forEach((q, i) => {
      expect(q.options[q.answerIndex]).toBe(`Right ${i}`);
    });
  });

  it("shifts the spread by round", () => {
    const r1 = spreadAnswerPositions(clustered(4), 1).map((q) => q.answerIndex);
    const r2 = spreadAnswerPositions(clustered(4), 2).map((q) => q.answerIndex);
    expect(r1).not.toEqual(r2);
  });

  it("leaves malformed rows untouched", () => {
    const bad = [
      { question: "x?", options: ["a", "b"], answerIndex: 0 },
      { question: "y?", options: ["a", "b", "c", "d"], answerIndex: 9 },
    ] as McqQuestion[];
    expect(spreadAnswerPositions(bad, 1)).toEqual(bad);
  });
});

describe("parseMcqCount", () => {
  it("parses leading and inline counts", () => {
    expect(parseMcqCount("15 photosynthesis")).toMatchObject({ count: 15 });
    expect(parseMcqCount("solar system 5 questions")).toMatchObject({ count: 5 });
    expect(parseMcqCount("World War 2")).toMatchObject({ count: 2 });
  });

  it("hashes questions case-insensitively", () => {
    expect(hashQuestion("What is X?")).toBe(hashQuestion("what is x"));
  });
});
