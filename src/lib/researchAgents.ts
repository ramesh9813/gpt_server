// Pure building blocks for the deep-research agent pipeline: budget
// constants, lenient JSON parsers, a concurrency limiter and the prompts.
// No network, no config imports — unit-testable in isolation. The
// orchestration that calls providers and tools lives in
// modules/chat/deepResearch.ts.

export type ResearchFinding = {
  claim: string;
  evidence: string;
  sourceUrl: string;
  subQuestion: string;
};

export type VerifierVerdict = {
  complete: boolean;
  gaps: string[];
  unsupportedClaims: string[];
};

// Budgets: cap fan-out, steps, rounds and payload sizes so a deep-research
// run can never spiral in cost or time.
export const RESEARCH_MIN_SUB_QUESTIONS = 3;
export const RESEARCH_MAX_SUB_QUESTIONS = 6;
export const RESEARCH_MAX_STEPS = 5;
// Gap-refill rounds after the first research pass (verify → re-research).
export const RESEARCH_VERIFIER_ROUNDS = 2;
export const RESEARCH_CONCURRENCY = 3;
export const RESEARCHER_MAX_TOKENS = 1200;
export const PLANNER_MAX_TOKENS = 500;
export const VERIFIER_MAX_TOKENS = 500;
export const RESEARCH_MAX_SOURCES = 60;
export const FETCH_PAGE_MAX_CHARS = 6000;
export const RESEARCHER_MAX_FINDINGS = 6;

const stripFences = (t: string): string =>
  (t || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();

// Lenient JSON extraction: parse the whole text, else the first balanced
// [...] or {...} span inside it. Models wrap arrays in prose often enough
// that strict parsing would lose most agent output.
const extractJson = (text: string): unknown | null => {
  const cleaned = stripFences(text);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }
  for (const re of [/\[[\s\S]*\]/, /\{[\s\S]*\}/]) {
    const m = cleaned.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[0]);
    } catch {
      // try the next shape
    }
  }
  return null;
};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

/** Planner output: 3–6 independent sub-question strings. [] when unusable. */
export const parseSubQuestions = (text: string): string[] => {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : null;
  if (!list) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of asStringArray(list)) {
    const t = q.trim().slice(0, 300);
    const key = t.toLowerCase();
    if (t.length < 4 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= RESEARCH_MAX_SUB_QUESTIONS) break;
  }
  return out;
};

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /^https?:\/\//i.test(t) ? t : null;
};

/** Researcher output: findings [{claim, evidence, sourceUrl}]. Every claim
 *  must carry an http(s) source — prose without a source is dropped. */
export const parseFindings = (text: string, subQuestion: string): ResearchFinding[] => {
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : null;
  if (!list) return [];
  const out: ResearchFinding[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const claim = typeof o.claim === "string" ? o.claim.trim().slice(0, 400) : "";
    const evidence = typeof o.evidence === "string" ? o.evidence.trim().slice(0, 600) : "";
    const sourceUrl = httpUrl(o.sourceUrl ?? o.source_url ?? o.url);
    if (!claim || !sourceUrl) continue;
    if (out.some((f) => f.claim.toLowerCase() === claim.toLowerCase())) continue;
    out.push({ claim, evidence, sourceUrl, subQuestion: subQuestion.slice(0, 200) });
    if (out.length >= RESEARCHER_MAX_FINDINGS) break;
  }
  return out;
};

/** Verifier output: {complete, gaps[], unsupportedClaims[]}. An unparseable
 *  verdict counts as complete — never loop forever on a bad reply. */
export const parseVerifierVerdict = (text: string): VerifierVerdict => {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { complete: true, gaps: [], unsupportedClaims: [] };
  }
  const o = parsed as Record<string, unknown>;
  const gaps = asStringArray(o.gaps).map((g) => g.trim().slice(0, 300)).slice(0, RESEARCH_MAX_SUB_QUESTIONS);
  const unsupportedClaims = asStringArray(o.unsupportedClaims ?? o.unsupported_claims)
    .map((c) => c.trim().slice(0, 300))
    .slice(0, RESEARCHER_MAX_FINDINGS);
  const complete = o.complete === true || (gaps.length === 0 && unsupportedClaims.length === 0);
  return { complete, gaps: complete ? [] : gaps, unsupportedClaims };
};

/** Tiny promise semaphore — caps concurrent async jobs without a dependency.
 *  Jobs still run in submission order; rejected jobs release their slot. */
export const makeLimiter = (concurrency: number) => {
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      release();
    }
  };
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const buildPlannerPrompt = (question: string): string =>
  `Split this research question into ${RESEARCH_MIN_SUB_QUESTIONS}-${RESEARCH_MAX_SUB_QUESTIONS} independent sub-questions that together cover it fully ` +
  `(facts, context, comparisons, recent developments). Independent means each can be researched on its own in parallel. ` +
  `Reply with ONLY a JSON array of question strings, no other text.\n\nQuestion: ${question}`;

export const RESEARCHER_SYSTEM_PROMPT =
  "You are a web research agent answering exactly ONE sub-question. " +
  "Use the web_search tool to find sources and fetch_page to read the most promising result when a snippet is not enough. " +
  "Search more than once with different phrasings when results are weak. " +
  "When you have enough evidence, reply with ONLY a JSON array of findings, each " +
  '{"claim": "one-sentence factual claim", "evidence": "the exact supporting fact or quote from the source", "sourceUrl": "https://…"} — ' +
  "2 to 6 findings, every claim backed by a real source URL you actually saw. " +
  "Never invent URLs. No prose outside the JSON.";

export const buildNoToolResearcherPrompt = (
  subQuestion: string,
  searchBlock: string
): string =>
  `You are a web research agent. Below are live web results for ONE sub-question. ` +
  `Reply with ONLY a JSON array of findings, each ` +
  '{"claim": "one-sentence factual claim", "evidence": "the exact supporting fact from the results", "sourceUrl": "one of the result URLs"} — ' +
  "2 to 6 findings. Use only the URLs present in the results; never invent one. No prose outside the JSON.\n\n" +
  `Sub-question: ${subQuestion}\n\n${searchBlock}`;

export const buildVerifierPrompt = (question: string, findingsDigest: string): string =>
  `You are an adversarial research verifier. Original question:\n${question}\n\n` +
  `Findings collected so far:\n${findingsDigest || "(none)"}\n\n` +
  `Check strictly: (1) Does every part of the ORIGINAL question have a sourced answer? ` +
  `(2) Do any findings contradict each other? (3) Which claims look important but unsupported?\n` +
  `Reply with ONLY JSON: {"complete": boolean, "gaps": ["missing sub-question …"], "unsupportedClaims": ["claim …"]}. ` +
  `"complete" is true only when the findings suffice to write a well-sourced report answering the whole question. ` +
  `"gaps" lists precise NEW sub-questions to research (max 3); use [] when complete. No other text.`;

/** The writer's context: verified findings + a numbered source index. The
 *  writer must ground every fact in these and cite by source number. */
export const buildWriterBrief = (
  question: string,
  findings: ResearchFinding[],
  unsupportedClaims: string[]
): string => {
  const sources = new Map<string, string>();
  for (const f of findings) {
    if (!sources.has(f.sourceUrl)) sources.set(f.sourceUrl, f.sourceUrl);
  }
  const index = [...sources.keys()];
  const numbered = (url: string): number => Math.max(1, index.indexOf(url) + 1);
  const lines = findings.map(
    (f) => `- ${f.claim}${f.evidence ? ` — evidence: ${f.evidence}` : ""} [${numbered(f.sourceUrl)}]`
  );
  const sourceLines = index.map((url, i) => `[${i + 1}] ${url}`);
  const dropped =
    unsupportedClaims.length > 0
      ? `\n\nClaims dropped as unsupported during verification (do NOT restate them as fact):\n${unsupportedClaims
          .map((c) => `- ${c}`)
          .join("\n")}`
      : "";
  return (
    `Verified research findings collected by parallel research agents for the question:\n"${question}"\n\n` +
    `FINDINGS (ground every factual claim in these; cite each use as [n] matching the numbered sources below):\n` +
    (lines.length > 0 ? lines.join("\n") : "(no verified findings — answer from general knowledge and say so)") +
    `\n\nSOURCES:\n${sourceLines.length > 0 ? sourceLines.join("\n") : "(none)"}` +
    dropped
  );
};
