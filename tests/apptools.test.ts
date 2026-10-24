/// <reference types="jest" />
// Pure guard layer for the model-driven app tools (lib/artifactGuard) —
// this is the trust boundary between model output and the UI.
import {
  buildMcqGenerationPrompt,
  extractHtmlDocument,
  extractJson,
  validateArtifactHtml,
  validateMcqQuestions,
} from "../src/lib/artifactGuard";

const goodQuestion = (over: Partial<{ question: string; options: string[]; answerIndex: number; explanation: string }> = {}) => ({
  question: "What is 2+2?",
  options: ["3", "4", "5", "6"],
  answerIndex: 1,
  explanation: "Basic arithmetic.",
  ...over,
});

describe("validateMcqQuestions", () => {
  it("accepts a valid question set", () => {
    expect(validateMcqQuestions([goodQuestion(), goodQuestion({ question: "Capital of Nepal?", options: ["Pokhara", "Kathmandu", "Biratnagar", "Lalitpur"], answerIndex: 1, explanation: "Kathmandu is the capital." })])).toBeNull();
  });

  it("rejects wrong option count, dupes, bad index, empty explanation", () => {
    expect(validateMcqQuestions([goodQuestion({ options: ["a", "b", "c"] })])).toMatchInlineSnapshot(`"questions[0].options must contain exactly 4 options"`);
    expect(validateMcqQuestions([goodQuestion({ options: ["4", "4", "5", "6"] })])).toMatchInlineSnapshot(`"questions[0] has duplicate options"`);
    expect(validateMcqQuestions([goodQuestion({ answerIndex: 9 })])).toMatchInlineSnapshot(`"questions[0].answerIndex must be an integer 0-3"`);
    expect(validateMcqQuestions([goodQuestion({ explanation: "" })])).toMatchInlineSnapshot(`"questions[0].explanation is required (why the answer is correct)"`);
  });

  it("rejects non-arrays and empty arrays", () => {
    expect(validateMcqQuestions("nope")).toMatchInlineSnapshot(`"questions must be a non-empty JSON array"`);
    expect(validateMcqQuestions([])).toMatchInlineSnapshot(`"questions must be a non-empty JSON array"`);
  });
});

const doc = (body = "<canvas></canvas>") =>
  `<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body>${body}</body></html>`;

describe("validateArtifactHtml", () => {
  it("accepts a complete self-contained document", () => {
    expect(validateArtifactHtml(doc())).toBeNull();
  });

  it("rejects missing html wrapper and network/storage access", () => {
    expect(validateArtifactHtml("<p>no wrapper</p>")).toMatchInlineSnapshot(`"document must start with a <html> element"`);
    expect(validateArtifactHtml(doc("<script>fetch('/x')</script>"))).toMatchInlineSnapshot(`"document uses forbidden fetch() — everything must be self-contained (no network, no storage)"`);
    expect(validateArtifactHtml(doc("<script>localStorage.setItem('a','b')</script>"))).toMatchInlineSnapshot(`"document uses forbidden localStorage — everything must be self-contained (no network, no storage)"`);
    expect(validateArtifactHtml(doc("<script>new XMLHttpRequest()</script>"))).toMatchInlineSnapshot(`"document uses forbidden XMLHttpRequest — everything must be self-contained (no network, no storage)"`);
  });

  it("rejects oversized documents", () => {
    const problem = validateArtifactHtml(doc("x".repeat(200_001)));
    expect(problem !== null && problem.startsWith("document is")).toBe(true);
  });
});

describe("extractHtmlDocument", () => {
  it("pulls the document out of prose and fences", () => {
    const text = `Here is your simulation:\n\`\`\`html:artifact\n${doc()}\n\`\`\`\nEnjoy!`;
    expect(extractHtmlDocument(text)).toBe(doc());
  });

  it("handles a bare document and returns null when absent", () => {
    expect(extractHtmlDocument(doc())).toBe(doc());
    expect(extractHtmlDocument("just text, nothing here")).toBeNull();
  });
});

describe("extractJson", () => {
  it("parses wrapped JSON objects and arrays", () => {
    expect(extractJson('Here:\n{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("```json\n[1,2]\n```")).toEqual([1, 2]);
  });

  it("returns null on garbage", () => {
    expect(extractJson("no json")).toBeNull();
  });
});

describe("buildMcqGenerationPrompt", () => {
  it("names the topic and count and demands the exact shape", () => {
    const p = buildMcqGenerationPrompt("photosynthesis", 5);
    expect(p).toContain("photosynthesis");
    expect(p).toContain("EXACTLY 5");
    expect(p).toContain("answerIndex");
    expect(p).toContain("explanation");
  });
});
