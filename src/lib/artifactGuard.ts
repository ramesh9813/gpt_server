// Pure validators and extractors for the model-driven app tools
// (generate_mcq / create_artifact / create_simulation). No imports —
// unit-testable in isolation. Server-side validation is the trust boundary:
// everything a model writes is checked here BEFORE it reaches the UI.

export type GuardMcqQuestion = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
};

/** Validate model-supplied MCQ questions. Returns null when valid, else the
 *  first problem as a human-readable error the model can fix. Enforced:
 *  1-50 questions; non-empty question <=300; EXACTLY 4 distinct non-empty
 *  options <=200; answerIndex 0..3; non-empty explanation <=300. */
export const validateMcqQuestions = (questions: unknown): string | null => {
  if (!Array.isArray(questions) || questions.length === 0) {
    return "questions must be a non-empty JSON array";
  }
  if (questions.length > 50) {
    return "too many questions (max 50)";
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q || typeof q !== "object") return `questions[${i}] must be an object`;
    const o = q as Record<string, unknown>;
    const text = typeof o.question === "string" ? o.question.trim() : "";
    if (!text) return `questions[${i}].question is empty`;
    if (text.length > 300) return `questions[${i}].question exceeds 300 characters`;
    if (!Array.isArray(o.options) || o.options.length !== 4) {
      return `questions[${i}].options must contain exactly 4 options`;
    }
    const lowered = o.options.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""));
    if (lowered.some((x: string) => !x)) return `questions[${i}] has an empty option`;
    if (lowered.some((x: string) => x.length > 200)) return `questions[${i}] has an option over 200 characters`;
    if (new Set(lowered).size !== 4) return `questions[${i}] has duplicate options`;
    const ai = o.answerIndex;
    if (typeof ai !== "number" || !Number.isInteger(ai) || ai < 0 || ai > 3) {
      return `questions[${i}].answerIndex must be an integer 0-3`;
    }
    const expl = typeof o.explanation === "string" ? o.explanation.trim() : "";
    if (!expl) return `questions[${i}].explanation is required (why the answer is correct)`;
    if (expl.length > 300) return `questions[${i}].explanation exceeds 300 characters`;
  }
  return null;
};

// Sandboxing static checks: model-written HTML must be self-contained and
// must not reach the network or storage. The iframe sandbox blocks these at
// runtime too — this is the belt to that braces.
export const MAX_ARTIFACT_CHARS = 200_000;

const FORBIDDEN_HTML_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bfetch\s*\(/, label: "fetch()" },
  { re: /XMLHttpRequest/, label: "XMLHttpRequest" },
  { re: /\blocalStorage\b/, label: "localStorage" },
  { re: /\bsessionStorage\b/, label: "sessionStorage" },
  { re: /\bWebSocket\s*\(/, label: "WebSocket" },
  { re: /\bimport\s*\(/, label: "dynamic import()" },
  { re: /\beval\s*\(/, label: "eval()" },
];

/** Static check of a self-contained HTML document. null when it passes. */
export const validateArtifactHtml = (html: string): string | null => {
  if (!html || !html.trim()) return "document is empty";
  if (html.length > MAX_ARTIFACT_CHARS) {
    return `document is ${Math.round(html.length / 1000)}KB — the cap is ${MAX_ARTIFACT_CHARS / 1000}KB`;
  }
  if (!/<html[\s>]/i.test(html)) return "document must start with a <html> element";
  if (!/<\/html>/i.test(html)) return "document is incomplete — missing the closing </html>";
  for (const { re, label } of FORBIDDEN_HTML_PATTERNS) {
    if (re.test(html)) return `document uses forbidden ${label} — everything must be self-contained (no network, no storage)`;
  }
  return null;
};

/** Pull the first complete HTML document out of a model reply that may wrap
 *  it in prose and/or a code fence. null when no document is present. */
export const extractHtmlDocument = (text: string): string | null => {
  const src = (text || "").trim();
  const fence = /```(?:html:artifact|html)?\s*\n([\s\S]*?)```/.exec(src);
  const candidates = [fence?.[1], src].filter((c): c is string => !!c);
  for (const c of candidates) {
    const start = /<!DOCTYPE\s+html/i.test(c) ? c.search(/<!DOCTYPE\s+html/i) : c.search(/<html[\s>]/i);
    if (start < 0) continue;
    const end = c.toLowerCase().lastIndexOf("</html>");
    if (end < 0 || end <= start) continue;
    return c.slice(start, end + "</html>".length);
  }
  return null;
};

/** Prompt for the simulation-builder sub-agent: same output contract as the
 *  artifact system prompt, driven by the caller's brief. */
export const buildSimulationBuilderPrompt = (artifactPrompt: string, title: string, brief: string): string =>
  `${artifactPrompt}\n\nYou are building an interactive simulation titled "${title}".\nUser brief: ${brief}\n` +
  `Additional simulation requirements: canvas- or SVG-based rendering of the phenomenon, labeled sliders for every ` +
  `controllable parameter (with units), live value readouts, and a Reset button restoring defaults. ` +
  `Emit ONLY the single \`\`\`html:artifact block — no prose before or after.`;

/** Prompt asking the model to generate MCQ questions as strict JSON for the
 *  generate_mcq tool's topic-only mode. */
export const buildMcqGenerationPrompt = (topic: string, count: number): string =>
  `Generate EXACTLY ${count} multiple-choice quiz questions on the topic "${topic}". ` +
  `Reply with ONLY JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"why this option is correct"}]}. ` +
  `Exactly 4 options per question, exactly one correct (its index in answerIndex), a non-empty explanation for every question. No markdown, no extra text.`;

/** Lenient JSON extraction shared by the tool executors: parse the whole
 *  text, else the first balanced {...}/[...] span inside it. */
export const extractJson = (text: string): unknown | null => {
  const cleaned = (text || "")
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }
  for (const re of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
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
