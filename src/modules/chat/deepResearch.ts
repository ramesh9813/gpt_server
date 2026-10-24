// Deep-research agent pipeline: PLANNER splits the question, RESEARCHERS run
// in parallel (one agent per sub-question, tools: web_search + fetch_page),
// an adversarial VERIFIER turns gaps into targeted re-research (bounded
// rounds), and the WRITER streams the final report from verified findings.
// The writer is the turn's existing streaming call — this module hands it a
// findings brief, so persist/stream/sources machinery is shared with every
// other turn. Pure parsers/prompts live in lib/researchAgents.ts.

import { env } from "../../lib/config";
import { logger } from "../../lib/logger";
import { performWebSearchWithProvider, type WebResult } from "../../lib/websearch";
import { fetchPageContent } from "../../lib/pageContent";
import { callByokText } from "./byokCall";
import type { ByokRequest } from "../../lib/byok";
import {
  buildNoToolResearcherPrompt,
  buildPlannerPrompt,
  buildVerifierPrompt,
  buildWriterBrief,
  makeLimiter,
  parseFindings,
  parseSubQuestions,
  parseVerifierVerdict,
  RESEARCHER_MAX_TOKENS,
  RESEARCHER_SYSTEM_PROMPT,
  RESEARCH_CONCURRENCY,
  RESEARCH_MAX_SOURCES,
  RESEARCH_MAX_STEPS,
  RESEARCH_VERIFIER_ROUNDS,
  PLANNER_MAX_TOKENS,
  VERIFIER_MAX_TOKENS,
  FETCH_PAGE_MAX_CHARS,
  type ResearchFinding,
} from "../../lib/researchAgents";
import type { LlmToolDef } from "../llm/toolBridge";

// ---------------------------------------------------------------------------
// Provider wrappers — the only place tool-call wire format matters.
// ---------------------------------------------------------------------------

export type AgentToolCall = { id: string; name: string; arguments: string };

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export type AgentLlm = {
  // Tool-capable providers round-trip tool_calls; providers without tool
  // support just answer text (agents then use the search-first fallback).
  supportsTools: boolean;
  call(args: {
    system: string;
    messages: AgentMessage[];
    tools?: LlmToolDef[];
    maxTokens: number;
    temperature?: number;
  }): Promise<{ text: string; toolCalls: AgentToolCall[] }>;
};

type OpenAiMessageShape = {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
};

const parseOpenAiAgentReply = (message: OpenAiMessageShape | undefined): { text: string; toolCalls: AgentToolCall[] } => {
  const text = typeof message?.content === "string" ? message.content : "";
  const toolCalls: AgentToolCall[] = [];
  for (const tc of Array.isArray(message?.tool_calls) ? message!.tool_calls! : []) {
    const id = typeof tc?.id === "string" ? tc.id : `call_${Math.random().toString(36).slice(2, 10)}`;
    const name = typeof tc?.function?.name === "string" ? tc.function.name : "";
    const args = typeof tc?.function?.arguments === "string" ? tc.function.arguments : "{}";
    if (name) toolCalls.push({ id, name, arguments: args });
  }
  return { text, toolCalls };
};

/** Built-in path: OpenRouter (OpenAI tool-calling shape), non-streaming. */
export const openRouterAgentLlm = (model: string): AgentLlm => ({
  supportsTools: true,
  call: async ({ system, messages, tools, maxTokens, temperature }) => {
    const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_ORIGIN,
        "X-Title": "ChatUI",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        max_tokens: maxTokens,
        temperature: temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      throw new Error(`agent model call failed (${response.status})`);
    }
    const json = (await response.json()) as any;
    return parseOpenAiAgentReply(json?.choices?.[0]?.message);
  },
});

/** BYOK path: OpenAI-shaped providers get real tool calling; other kinds
 *  (Gemini/Anthropic wire formats) answer text-only and agents fall back to
 *  the deterministic search-first researcher. */
export const byokAgentLlm = (byok: ByokRequest): AgentLlm => ({
  supportsTools: byok.provider.kind === "openai",
  call: async ({ system, messages, tools, maxTokens, temperature }) => {
    if (byok.provider.kind !== "openai") {
      const flat = [
        system,
        ...messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`),
      ].join("\n\n");
      const text = await callByokText(byok, flat, { maxTokens, temperature: temperature ?? 0.3 });
      return { text: text ?? "", toolCalls: [] };
    }
    const response = await fetch(`${byok.provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${byok.apiKey}`,
        ...(byok.provider.chatHeaders ?? {}),
      },
      body: JSON.stringify({
        model: byok.model,
        messages: [{ role: "system", content: system }, ...messages],
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        max_tokens: maxTokens,
        temperature: temperature ?? 0.3,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      throw new Error(`agent model call failed (${response.status})`);
    }
    const json = (await response.json()) as any;
    return parseOpenAiAgentReply(json?.choices?.[0]?.message);
  },
});

// ---------------------------------------------------------------------------
// Researcher tools: web_search + fetch_page
// ---------------------------------------------------------------------------

const WEB_SEARCH_TOOL: LlmToolDef = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web (Brave, Exa, YouTube, DuckDuckGo in parallel). Returns titles, URLs and content snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max: { type: "number", description: "Max results (3-10, default 6)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const FETCH_PAGE_TOOL: LlmToolDef = {
  type: "function",
  function: {
    name: "fetch_page",
    description: "Fetch one web page and return its readable text. Use on the most promising search result when the snippet is not enough.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute http(s) URL to read" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
};

type SourceRegistry = {
  add: (hits: WebResult[]) => void;
  list: () => Array<{ title: string; url: string }>;
};

const makeSourceRegistry = (onSource?: (s: { title: string; url: string }) => void): SourceRegistry => {
  const map = new Map<string, { title: string; url: string }>();
  return {
    add: (hits) => {
      for (const h of hits) {
        if (map.size >= RESEARCH_MAX_SOURCES) return;
        if (!/^https?:\/\//i.test(h.url) || map.has(h.url)) continue;
        map.set(h.url, { url: h.url, title: h.title || h.url });
        onSource?.({ url: h.url, title: h.title || h.url });
      }
    },
    list: () => [...map.values()],
  };
};

const parseToolArgs = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------------------
// The reusable agent loop: call the model, run its tool calls in parallel,
// feed results back, repeat until it answers without tools (or the step
// limit hits — partial beats failing).
// ---------------------------------------------------------------------------

export const runAgent = async (args: {
  llm: AgentLlm;
  system: string;
  input: string;
  tools?: LlmToolDef[];
  toolImpl?: Record<string, (toolArgs: Record<string, unknown>) => Promise<string>>;
  maxSteps: number;
  maxTokens: number;
}): Promise<string> => {
  const messages: AgentMessage[] = [{ role: "user", content: args.input }];
  const tools = args.llm.supportsTools && args.tools && args.tools.length > 0 ? args.tools : undefined;
  let lastText = "";
  for (let step = 0; step < args.maxSteps; step++) {
    const res = await args.llm.call({
      system: args.system,
      messages,
      tools,
      maxTokens: args.maxTokens,
    });
    lastText = res.text || lastText;
    if (tools && res.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: res.text ?? "",
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      const results = await Promise.all(
        res.toolCalls.map(async (tc): Promise<{ id: string; output: string }> => {
          const impl = args.toolImpl?.[tc.name];
          if (!impl) return { id: tc.id, output: `Error: unknown tool "${tc.name}"` };
          try {
            return { id: tc.id, output: await impl(parseToolArgs(tc.arguments)) };
          } catch (err: unknown) {
            const msg = (err as { message?: unknown })?.message;
            return { id: tc.id, output: `Error: ${typeof msg === "string" && msg ? msg : "tool failed"}` };
          }
        })
      );
      for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
      continue;
    }
    return res.text;
  }
  return lastText;
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type DeepResearchResult = {
  brief: string;
  sources: Array<{ title: string; url: string }>;
  subQuestions: string[];
};

export const runDeepResearch = async (args: {
  question: string;
  provider: "auto" | "brave" | "exa" | "youtube" | "duckduckgo";
  depth: number;
  llm: AgentLlm;
  onStage: (text: string) => void;
  onSource?: (s: { title: string; url: string }) => void;
  isAborted?: () => boolean;
}): Promise<DeepResearchResult> => {
  const registry = makeSourceRegistry(args.onSource);
  const findings: ResearchFinding[] = [];
  const droppedClaims: string[] = [];
  const aborted = (): boolean => args.isAborted?.() === true;

  const searchTool = async (toolArgs: Record<string, unknown>): Promise<string> => {
    const query = typeof toolArgs.query === "string" ? toolArgs.query.trim().slice(0, 300) : "";
    if (!query) return "Error: missing query";
    const n =
      typeof toolArgs.max === "number" && Number.isFinite(toolArgs.max)
        ? Math.min(10, Math.max(3, Math.floor(toolArgs.max)))
        : 6;
    const { hits } = await performWebSearchWithProvider(query, n, args.provider);
    registry.add(hits);
    if (hits.length === 0) return "No results — try different phrasing.";
    return hits.map((h: WebResult, i: number) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
  };

  const fetchPageTool = async (toolArgs: Record<string, unknown>): Promise<string> => {
    const url = typeof toolArgs.url === "string" ? toolArgs.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return "Error: url must be an absolute http(s) URL";
    const page = await fetchPageContent(url);
    if (!page) return "Error: page unreadable (blocked, empty or too large)";
    registry.add([{ title: page.title, url: page.url, snippet: "" }]);
    return page.text.length > FETCH_PAGE_MAX_CHARS
      ? `${page.text.slice(0, FETCH_PAGE_MAX_CHARS)}\n…[truncated ${page.text.length - FETCH_PAGE_MAX_CHARS} chars]`
      : page.text;
  };

  // Search-first researcher for providers without tool calling (and as the
  // fallback when a tool agent yields nothing): deterministic search, read
  // the top pages, then extract findings from what came back.
  const runSearchFirstResearcher = async (subQuestion: string): Promise<ResearchFinding[]> => {
    const { hits } = await performWebSearchWithProvider(subQuestion, Math.min(args.depth, 8), args.provider);
    registry.add(hits);
    if (hits.length === 0) return [];
    const top: Array<{ title: string; url: string; text: string } | null> = await Promise.all(
      hits.slice(0, 2).map((h: WebResult) =>
        fetchPageContent(h.url).catch((): null => null)
      )
    );
    const pageBlocks = top
      .filter((p): p is { title: string; url: string; text: string } => p !== null)
      .map((p) => `PAGE ${p.title} — ${p.url}\n${p.text.slice(0, FETCH_PAGE_MAX_CHARS)}`);
    const searchBlock = hits.map((h: WebResult, i: number) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
    const prompt = buildNoToolResearcherPrompt(subQuestion, [searchBlock, ...pageBlocks].join("\n\n"));
    const text = await args.llm.call({
      system: RESEARCHER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      maxTokens: RESEARCHER_MAX_TOKENS,
    });
    return parseFindings(text.text, subQuestion);
  };

  const runResearcher = async (subQuestion: string): Promise<ResearchFinding[]> => {
    try {
      if (args.llm.supportsTools) {
        const text = await runAgent({
          llm: args.llm,
          system: RESEARCHER_SYSTEM_PROMPT,
          input: `Sub-question to research: ${subQuestion}`,
          tools: [WEB_SEARCH_TOOL, FETCH_PAGE_TOOL],
          toolImpl: { web_search: searchTool, fetch_page: fetchPageTool },
          maxSteps: RESEARCH_MAX_STEPS,
          maxTokens: RESEARCHER_MAX_TOKENS,
        });
        const parsed = parseFindings(text, subQuestion);
        if (parsed.length > 0) return parsed;
      }
      return await runSearchFirstResearcher(subQuestion);
    } catch (err) {
      logger.warn({ err }, "researcher agent failed");
      return [];
    }
  };

  // 1. PLANNER — split into independent sub-questions.
  args.onStage("Planning research…");
  let subQuestions: string[] = [];
  try {
    const plan = await args.llm.call({
      system: "You are a research planner. Output strict JSON only.",
      messages: [{ role: "user", content: buildPlannerPrompt(args.question) }],
      maxTokens: PLANNER_MAX_TOKENS,
      temperature: 0.2,
    });
    subQuestions = parseSubQuestions(plan.text);
  } catch (err) {
    logger.warn({ err }, "planner failed");
  }
  if (subQuestions.length === 0) subQuestions = [args.question];
  args.onStage(`Planned ${subQuestions.length} sub-questions — researching…`);

  // 2-3. RESEARCHERS in parallel (bounded), then the VERIFIER gap loop.
  const limit = makeLimiter(RESEARCH_CONCURRENCY);
  let queue = subQuestions;
  for (let round = 0; round <= RESEARCH_VERIFIER_ROUNDS; round++) {
    if (aborted()) break;
    let done = 0;
    const settled = await Promise.allSettled(
      queue.map((q) =>
        limit(async () => {
          done += 1;
          const short = q.length > 60 ? `${q.slice(0, 57)}…` : q;
          args.onStage(`Researching ${done}/${queue.length}: ${short}…`);
          return runResearcher(q);
        })
      )
    );
    for (const s of settled) {
      if (s.status === "fulfilled") findings.push(...s.value);
    }
    if (round === RESEARCH_VERIFIER_ROUNDS || aborted()) break;

    args.onStage(`Verifying ${findings.length} findings…`);
    const digest = findings
      .map((f, i) => `${i + 1}. ${f.claim} (source: ${f.sourceUrl})`)
      .join("\n")
      .slice(0, 6000);
    let verdict: ReturnType<typeof parseVerifierVerdict> | null = null;
    try {
      const v = await args.llm.call({
        system: "You are an adversarial research verifier. Output strict JSON only.",
        messages: [{ role: "user", content: buildVerifierPrompt(args.question, digest) }],
        maxTokens: VERIFIER_MAX_TOKENS,
        temperature: 0.2,
      });
      verdict = parseVerifierVerdict(v.text);
    } catch (err) {
      logger.warn({ err }, "verifier failed");
    }
    if (!verdict || verdict.complete || verdict.gaps.length === 0) break;
    droppedClaims.push(...verdict.unsupportedClaims);
    queue = verdict.gaps;
    args.onStage(`Verifier found ${queue.length} gap${queue.length === 1 ? "" : "s"} — researching round ${round + 2}…`);
  }

  // 4. WRITER brief — the turn's streaming call writes from this.
  args.onStage("Writing report…");
  return {
    brief: buildWriterBrief(args.question, findings, droppedClaims),
    sources: registry.list(),
    subQuestions,
  };
};
