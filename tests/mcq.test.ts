/// <reference types="jest" />
jest.mock("../src/lib/prisma", () => ({ prisma: {} }));
// MCQ quiz helpers: answer spread must hold no matter how the model
// clusters correct positions, and malformed rows pass through untouched.
import { extractCompleteMcqQuestions, hashQuestion, parseMcqCount, spreadAnswerPositions, type McqQuestion } from "../src/modules/chat/mcq";

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
    // Trailing "2" is part of the topic, not a count — default applies.
    expect(parseMcqCount("World War 2")).toMatchObject({ count: 10, cleanTopic: "World War 2" });
  });

  it("hashes questions case-insensitively", () => {
    expect(hashQuestion("What is X?")).toBe(hashQuestion("what is x"));
  });
});

describe("extractCompleteMcqQuestions", () => {
  const q1 = `{"question":"Capital of France?","options":["Paris","Rome","Berlin","Madrid"],"answerIndex":0,"explanation":"Paris"}`;
  const q2 = `{"question":"2+2?","options":["3","4","5","6"],"answerIndex":1}`;
  const full = `{"questions":[${q1},${q2}]}`;

  it("extracts every complete question from a finished buffer", () => {
    const out = extractCompleteMcqQuestions(full);
    expect(out).toHaveLength(2);
    expect(out[0].question).toBe("Capital of France?");
    expect(out[1].answerIndex).toBe(1);
  });

  it("yields only finished questions from a partial buffer", () => {
    const partial = `{"questions":[${q1},${q2.slice(0, 20)}`;
    const out = extractCompleteMcqQuestions(partial);
    expect(out).toHaveLength(1);
    expect(out[0].question).toBe("Capital of France?");
  });

  it("returns nothing mid-first-question, everything once it closes", () => {
    const cut = q1.slice(0, 30);
    expect(extractCompleteMcqQuestions(`{"questions":[${cut}`)).toHaveLength(0);
    expect(extractCompleteMcqQuestions(`{"questions":[${q1}`)).toHaveLength(1);
  });

  it("skips invalid objects and tolerates fences", () => {
    const bad = `{"foo":"bar"}`;
    expect(extractCompleteMcqQuestions(`\`\`\`json\n{"questions":[${bad},${q1}]}\n\`\`\``)).toHaveLength(1);
  });

  it("handles braces inside strings", () => {
    const tricky = `{"question":"Which set is {a, b}?","options":["{a}","{b}","{a, b}","none"],"answerIndex":2}`;
    const out = extractCompleteMcqQuestions(`{"questions":[${tricky}]}`);
    expect(out).toHaveLength(1);
    expect(out[0].answerIndex).toBe(2);
  });
});
