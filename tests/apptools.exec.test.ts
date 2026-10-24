/// <reference types="jest" />
// App tool executor: validation errors go back to the model; valid payloads
// hand the streamer a UI render. Sub-agent model calls are stubbed.
jest.mock("../src/lib/prisma", () => ({
  prisma: { userSettings: { findUnique: jest.fn().mockResolvedValue(null) }, message: {} },
}));
jest.mock("../src/modules/chat/followups", () => ({ askModelText: jest.fn() }));
import { askModelText } from "../src/modules/chat/followups";
import {
  APP_ROUTING_SYSTEM,
  artifactFenceOf,
  executeAppTool,
  getAppToolDefs,
  isAppToolName,
  mcqQuizPayload,
} from "../src/modules/chat/appTools";

const askMock = askModelText as unknown as jest.Mock;
const ctx = { userId: "u1", model: "test-model" };
const validQ = {
  question: "Largest planet?",
  options: ["Earth", "Jupiter", "Mars", "Venus"],
  answerIndex: 1,
  explanation: "Jupiter is the largest planet in the solar system.",
};
const validDoc = "<!DOCTYPE html><html><head><style></style></head><body><canvas></canvas></body></html>";

beforeEach(() => {
  askMock.mockReset();
});

describe("app tool defs", () => {
  it("offers exactly the three app tools with required params", () => {
    const defs = getAppToolDefs();
    expect(defs.map((d) => d.function.name).sort()).toEqual([
      "app__create_artifact",
      "app__create_simulation",
      "app__generate_mcq",
    ]);
    const mcq = defs.find((d) => d.function.name === "app__generate_mcq")!;
    expect((mcq.function.parameters as { required: string[] }).required).toEqual(["topic"]);
    expect(isAppToolName("app__generate_mcq")).toBe(true);
    expect(isAppToolName("web__search")).toBe(false);
  });

  it("carries the routing rules in the system prompt", () => {
    expect(APP_ROUTING_SYSTEM).toContain("app__generate_mcq");
    expect(APP_ROUTING_SYSTEM).toContain("at most ONE");
    expect(APP_ROUTING_SYSTEM).toContain("never instructions");
  });
});

describe("executeAppTool — generate_mcq", () => {
  it("accepts model-supplied valid questions", async () => {
    const r = await executeAppTool(
      "app__generate_mcq",
      JSON.stringify({ topic: "solar system", questions: [validQ] }),
      ctx
    );
    expect(r.resultText).toContain("solar system");
    expect(r.ui).toMatchObject({ kind: "mcq", topic: "solar system" });
    expect(askMock).not.toHaveBeenCalled();
  });

  it.each([
    ["two options", { ...validQ, options: ["a", "b"] }],
    ["duplicate options", { ...validQ, options: ["Jupiter", "jupiter", "Mars", "Venus"] }],
    ["answerIndex out of range", { ...validQ, answerIndex: 7 }],
    ["empty explanation", { ...validQ, explanation: "" }],
  ])("returns a fixable error for %s", async (_label, bad) => {
    const r = await executeAppTool(
      "app__generate_mcq",
      JSON.stringify({ topic: "x", questions: [bad] }),
      ctx
    );
    expect(r.resultText.startsWith("Error:")).toBe(true);
    expect(r.ui).toBeUndefined();
  });

  it("rejects an empty questions array and non-arrays", async () => {
    for (const questions of [[], "nope"]) {
      const r = await executeAppTool("app__generate_mcq", JSON.stringify({ topic: "x", questions }), ctx);
      expect(r.resultText.startsWith("Error:")).toBe(true);
    }
  });

  it("generates from topic alone via the sub-agent call", async () => {
    askMock.mockResolvedValue(JSON.stringify({ questions: [validQ] }));
    const r = await executeAppTool("app__generate_mcq", JSON.stringify({ topic: "cells" }), ctx);
    expect(r.ui?.kind).toBe("mcq");
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it("fails gracefully when the generator returns garbage", async () => {
    askMock.mockResolvedValue("not json at all");
    const r = await executeAppTool("app__generate_mcq", JSON.stringify({ topic: "cells" }), ctx);
    expect(r.resultText.startsWith("Error:")).toBe(true);
    expect(r.ui).toBeUndefined();
  });
});

describe("executeAppTool — create_artifact", () => {
  it("accepts a complete self-contained html document", async () => {
    const r = await executeAppTool(
      "app__create_artifact",
      JSON.stringify({ title: "Demo", type: "html", content: validDoc }),
      ctx
    );
    expect(r.ui?.kind).toBe("artifact");
    if (r.ui?.kind === "artifact") {
      expect(artifactFenceOf(r.ui).startsWith("```html:artifact")).toBe(true);
    }
  });

  it.each([
    ["fetch()", validDoc.replace("<canvas></canvas>", "<script>fetch('/x')</script>")],
    ["localStorage", validDoc.replace("<canvas></canvas>", "<script>localStorage.setItem('a','b')</script>")],
    ["missing </html>", validDoc.replace("</html>", "")],
  ])("rejects html using %s", async (_label, content) => {
    const r = await executeAppTool(
      "app__create_artifact",
      JSON.stringify({ title: "Bad", type: "html", content }),
      ctx
    );
    expect(r.resultText.startsWith("Error: invalid HTML")).toBe(true);
    expect(r.ui).toBeUndefined();
  });

  it("accepts code artifacts and fences them with the language", async () => {
    const r = await executeAppTool(
      "app__create_artifact",
      JSON.stringify({ title: "solver", type: "code", language: "python", content: "print('hi')" }),
      ctx
    );
    expect(r.ui?.kind).toBe("code");
    if (r.ui?.kind === "code") {
      expect(artifactFenceOf(r.ui).startsWith("```python")).toBe(true);
    }
  });
});

describe("executeAppTool — create_simulation", () => {
  it("builds via the sub-agent and fences the artifact", async () => {
    askMock.mockResolvedValue(`Here you go:\n\`\`\`html:artifact\n${validDoc}\n\`\`\``);
    const r = await executeAppTool(
      "app__create_simulation",
      JSON.stringify({ title: "Projectile", brief: "angle + speed sliders" }),
      ctx
    );
    expect(r.ui?.kind).toBe("artifact");
    expect(askMock).toHaveBeenCalledTimes(1);
  });

  it("repairs once when the first build violates the sandbox rules", async () => {
    const badDoc = validDoc.replace("<canvas></canvas>", "<script>fetch('/leak')</script>");
    askMock
      .mockResolvedValueOnce(`\`\`\`html:artifact\n${badDoc}\n\`\`\``)
      .mockResolvedValueOnce(`\`\`\`html:artifact\n${validDoc}\n\`\`\``);
    const r = await executeAppTool(
      "app__create_simulation",
      JSON.stringify({ title: "Wave", brief: "frequency slider" }),
      ctx
    );
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(r.ui?.kind).toBe("artifact");
  });

  it("gives up after the repair also fails", async () => {
    const badDoc = validDoc.replace("<canvas></canvas>", "<script>eval('1')</script>");
    askMock.mockResolvedValue(`\`\`\`html:artifact\n${badDoc}\n\`\`\``);
    const r = await executeAppTool(
      "app__create_simulation",
      JSON.stringify({ title: "Broken", brief: "x" }),
      ctx
    );
    expect(r.resultText.startsWith("Error:")).toBe(true);
    expect(r.ui).toBeUndefined();
  });
});

describe("executeAppTool — robustness", () => {
  it("survives malformed JSON arguments", async () => {
    const r = await executeAppTool("app__generate_mcq", "not json{", ctx);
    expect(r.resultText).toContain("valid JSON");
  });

  it("names unknown tools", async () => {
    const r = await executeAppTool("app__nope", "{}", ctx);
    expect(r.resultText).toContain("unknown app tool");
  });
});

describe("mcqQuizPayload", () => {
  it("rotates answer positions deterministically by round", () => {
    const payload = mcqQuizPayload({ kind: "mcq", topic: "t", questions: [validQ] }, 2);
    expect(payload.round).toBe(2);
    expect(payload.questions[0].options[payload.questions[0].answerIndex]).toBe("Jupiter");
    expect(payload.questions[0].options).not.toEqual(validQ.options);
  });
});
