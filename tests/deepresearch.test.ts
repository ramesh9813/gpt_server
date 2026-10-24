/// <reference types="jest" />
// Pure agent-pipeline building blocks (lib/researchAgents) — no network, no
// config imports, so this suite runs in any environment.
import {
  buildWriterBrief,
  makeLimiter,
  parseFindings,
  parseSubQuestions,
  parseVerifierVerdict,
  RESEARCH_MAX_SUB_QUESTIONS,
  type ResearchFinding,
} from "../src/lib/researchAgents";

describe("parseSubQuestions", () => {
  it("parses a plain JSON array", () => {
    const out = parseSubQuestions('["What is X?", "How does X work?", "Who uses X?"]');
    expect(out).toEqual(["What is X?", "How does X work?", "Who uses X?"]);
  });

  it("extracts the array from fenced/prose-wrapped output", () => {
    const text = '```json\n["Sub one?", "Sub two?", "Sub three?"]\n```';
    expect(parseSubQuestions(text)).toEqual(["Sub one?", "Sub two?", "Sub three?"]);
  });

  it("dedupes, drops junk and caps at the max", () => {
    const many = Array.from({ length: 10 }, (_, i) => `Question number ${i}?`);
    const out = parseSubQuestions(JSON.stringify([...many, "Question number 1?", "", 42]));
    expect(out.length).toBe(RESEARCH_MAX_SUB_QUESTIONS);
    expect(new Set(out.map((q) => q.toLowerCase())).size).toBe(out.length);
  });

  it("returns [] on garbage", () => {
    expect(parseSubQuestions("no json here")).toEqual([]);
  });
});

describe("parseFindings", () => {
  it("parses findings and tags each with its sub-question", () => {
    const json = JSON.stringify([
      { claim: "X doubles throughput", evidence: "benchmark table", sourceUrl: "https://a.dev/x" },
      { claim: "X launched in 2024", evidence: "", sourceUrl: "http://b.dev/y" },
    ]);
    const out = parseFindings(json, "What is X?");
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ claim: "X doubles throughput", sourceUrl: "https://a.dev/x", subQuestion: "What is X?" });
    expect(out[1].sourceUrl).toBe("http://b.dev/y");
  });

  it("drops claims without an http(s) source", () => {
    const json = JSON.stringify([
      { claim: "good", sourceUrl: "https://a.dev" },
      { claim: "no url", sourceUrl: "" },
      { claim: "ftp url", sourceUrl: "ftp://x" },
      "not an object",
    ]);
    const out = parseFindings(json, "q");
    expect(out.length).toBe(1);
    expect(out[0].claim).toBe("good");
  });

  it("extracts the array from surrounding prose", () => {
    const text = 'Here is what I found:\n[{"claim":"c","evidence":"e","sourceUrl":"https://s.dev"}]\nDone.';
    expect(parseFindings(text, "q").length).toBe(1);
  });
});

describe("parseVerifierVerdict", () => {
  it("parses an incomplete verdict with gaps", () => {
    const v = parseVerifierVerdict('{"complete":false,"gaps":["pricing comparison"],"unsupportedClaims":["claim A"]}');
    expect(v.complete).toBe(false);
    expect(v.gaps).toEqual(["pricing comparison"]);
    expect(v.unsupportedClaims).toEqual(["claim A"]);
  });

  it("treats missing gaps as complete", () => {
    const v = parseVerifierVerdict('{"complete":false,"gaps":[]}');
    expect(v.complete).toBe(true);
  });

  it("treats unparseable output as complete so the loop always ends", () => {
    expect(parseVerifierVerdict("verifier rambled").complete).toBe(true);
  });
});

describe("makeLimiter", () => {
  it("caps concurrent jobs and runs everything", async () => {
    const limit = makeLimiter(2);
    let active = 0;
    let peak = 0;
    const job = async (ms: number): Promise<number> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return ms;
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => limit(() => job(10))));
    expect(results).toEqual([10, 10, 10, 10, 10, 10]);
    expect(peak).toBe(2);
  });

  it("releases the slot when a job rejects", async () => {
    const limit = makeLimiter(1);
    const first = limit(async () => {
      throw new Error("boom");
    }).catch(() => "failed");
    const second = limit(async () => "ok");
    expect(await first).toBe("failed");
    expect(await second).toBe("ok");
  });
});

describe("buildWriterBrief", () => {
  it("numbers sources and marks unsupported claims", () => {
    const findings: ResearchFinding[] = [
      { claim: "First claim", evidence: "e1", sourceUrl: "https://a.dev", subQuestion: "q1" },
      { claim: "Second claim", evidence: "e2", sourceUrl: "https://b.dev", subQuestion: "q2" },
      { claim: "Also from A", evidence: "e3", sourceUrl: "https://a.dev", subQuestion: "q3" },
    ];
    const brief = buildWriterBrief("the question", findings, ["shaky claim"]);
    expect(brief).toContain("the question");
    expect(brief).toContain("First claim — evidence: e1 [1]");
    expect(brief).toContain("Also from A — evidence: e3 [1]");
    expect(brief).toContain("[2] https://b.dev");
    expect(brief).toContain("shaky claim");
  });

  it("handles zero findings without crashing", () => {
    const brief = buildWriterBrief("q", [], []);
    expect(brief).toContain("(no verified findings");
  });
});
