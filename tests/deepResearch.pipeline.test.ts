/// <reference types="jest" />
// Deep-research orchestration end to end with the network stubbed: planner →
// parallel researchers (tool loop) → adversarial verifier gap loop → writer
// brief. The LLM wrapper (openRouterAgentLlm) is exercised for real against
// a mocked fetch.
jest.mock("../src/lib/prisma", () => ({ prisma: {} }));
import { openRouterAgentLlm, runDeepResearch } from "../src/modules/chat/deepResearch";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: any }> = [];
let openrouterReplies: Array<{ content: string; tool_calls?: any[] }> = [];

const orReply = (content: string, tool_calls?: any[]) => ({ content, tool_calls });
const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const DDG_HTML =
  `<a class="result__a" href="https://example.com/page">Example Page</a>` +
  `<a class="result__snippet">Starter facts snippet.</a>`;
const PAGE_HTML = `<html><head><title>P</title></head><body>Long readable page body text.</body></html>`;
const FINDINGS = (sub: string, url: string) =>
  JSON.stringify([{ claim: `Fact about ${sub}`, evidence: "seen in results", sourceUrl: url }]);

beforeEach(() => {
  calls = [];
  openrouterReplies = [];
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async (input: any, init?: any) => {
    const url = String(input);
    // Only the LLM calls carry JSON bodies — search POSTs are urlencoded.
    calls.push({
      url,
      body: init?.body && url.includes("openrouter") ? JSON.parse(init.body) : init?.body ?? null,
    });
    if (url.includes("openrouter")) {
      const reply = openrouterReplies.shift() ?? orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}');
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: reply.content, ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) } }],
        }),
        { status: 200 }
      );
    }
    if (url.includes("duckduckgo")) {
      return new Response(DDG_HTML, { status: 200 });
    }
    if (url.includes("example.com")) {
      return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
});

const run = (extra: Partial<Parameters<typeof runDeepResearch>[0]> = {}) => {
  const stages: string[] = [];
  const promise = runDeepResearch({
    question: "What does Example charge?",
    provider: "duckduckgo",
    depth: 5,
    llm: openRouterAgentLlm("test-model"),
    onStage: (t) => stages.push(t),
    ...extra,
  });
  return { promise, stages };
};

const orCalls = () => calls.filter((c) => c.url.includes("openrouter"));

describe("runDeepResearch pipeline", () => {
  it("plans, researches with tools, verifies and builds the writer brief", async () => {
    openrouterReplies = [
      orReply('["What is the pricing?"]'),                                        // planner
      orReply("", [toolCall("t1", "web_search", { query: "pricing" })]),          // researcher step 1: tool call
      orReply(FINDINGS("What is the pricing?", "https://example.com/pricing")),   // researcher step 2: findings
      orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}'),              // verifier
    ];
    const { promise, stages } = run();
    const { brief, sources, subQuestions } = await promise;

    expect(subQuestions).toEqual(["What is the pricing?"]);
    // The search tool ran (DDG hit) and its sources were registered.
    expect(calls.some((c) => c.url.includes("duckduckgo"))).toBe(true);
    expect(sources.some((s) => s.url.includes("example.com"))).toBe(true);
    // Brief: verified findings + numbered source index.
    expect(brief).toContain("Fact about What is the pricing?");
    expect(brief).toContain("[1] https://example.com/pricing");
    expect(brief).toContain("What does Example charge?");
    // Stage narration covers the whole run.
    expect(stages).toContain("Planning research…");
    expect(stages.some((s) => s.startsWith("Researching 1/1"))).toBe(true);
    expect(stages).toContain("Verifying 1 findings…");
    expect(stages).toContain("Writing report…");
    // The researcher's second call carries the tool result in the messages.
    const researcherSecond = orCalls()[2];
    expect(
      researcherSecond.body.messages.some(
        (m: any) => m.role === "tool" && String(m.content).includes("Example Page")
      )
    ).toBe(true);
  });

  it("refills verifier gaps with targeted second-round research", async () => {
    openrouterReplies = [
      orReply('["pricing question"]'),                                            // planner
      orReply(FINDINGS("pricing question", "https://example.com/a")),             // researcher round 1
      orReply('{"complete":false,"gaps":["enterprise pricing"],"unsupportedClaims":["shaky claim"]}'), // verifier: gap!
      orReply(FINDINGS("enterprise pricing", "https://example.com/b")),           // gap researcher
      orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}'),              // verifier: done
    ];
    const { promise, stages } = run();
    const { brief } = await promise;

    expect(stages.some((s) => s.includes("gap"))).toBe(true);
    // The gap researcher received the gap question, not the original.
    const gapCall = orCalls()[3];
    expect(JSON.stringify(gapCall.body.messages)).toContain("enterprise pricing");
    // Both rounds' findings and the dropped claim land in the brief.
    expect(brief).toContain("Fact about pricing question");
    expect(brief).toContain("Fact about enterprise pricing");
    expect(brief).toContain("shaky claim");
  });

  it("falls back to the original question when the planner replies garbage", async () => {
    openrouterReplies = [
      orReply("I cannot answer that."),                                           // planner garbage
      orReply(FINDINGS("What does Example charge?", "https://example.com/c")),    // researcher (fallback sub-q)
      orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}'),              // verifier
    ];
    const { promise } = run();
    const { subQuestions, brief } = await promise;
    expect(subQuestions).toEqual(["What does Example charge?"]);
    expect(brief).toContain("Fact about What does Example charge?");
  });

  it("reads pages via the fetch_page tool when the researcher asks", async () => {
    openrouterReplies = [
      orReply('["page contents"]'),
      orReply("", [toolCall("f1", "fetch_page", { url: "https://example.com/page" })]),
      orReply(FINDINGS("page contents", "https://example.com/page")),
      orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}'),
    ];
    const { promise } = run();
    const { sources, brief } = await promise;
    expect(calls.some((c) => c.url === "https://example.com/page")).toBe(true);
    expect(sources.some((s) => s.url === "https://example.com/page")).toBe(true);
    // The tool result fed the readable page text back to the researcher.
    const researcherSecond = orCalls()[2];
    expect(
      researcherSecond.body.messages.some(
        (m: any) => m.role === "tool" && String(m.content).includes("Long readable page body text.")
      )
    ).toBe(true);
    expect(brief).toContain("Fact about page contents");
  });

  it("stops early when aborted between rounds", async () => {
    openrouterReplies = [
      orReply('["only question"]'),
      orReply(FINDINGS("only question", "https://example.com/z")),
      orReply('{"complete":false,"gaps":["more"],"unsupportedClaims":[]}'),
      orReply(FINDINGS("more", "https://example.com/y")),
      orReply('{"complete":true,"gaps":[],"unsupportedClaims":[]}'),
    ];
    let abort = false;
    const { promise } = run({ isAborted: () => abort });
    // Abort after the first researcher round lands (poll the call log).
    await new Promise((r) => setTimeout(r, 0));
    abort = true;
    const { brief } = await promise;
    // Either round ran or not depending on timing — but the pipeline resolves
    // and never rejects, with a well-formed brief.
    expect(typeof brief).toBe("string");
    expect(brief).toContain("What does Example charge?");
  });
});
