// MCQ quiz turn — split from chat.service.ts. No logic changes.
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { sseHead, sseSend, sseEnd, finishTextReply } from "./sse";
import { logger } from "../../lib/logger";
import type { ByokRequest } from "../../lib/byok";
import { callByokText } from "./byokCall";

// ---------------------------------------------------------------------------
// MCQ quiz generation (non-streaming turn, SSE-framed quiz event)
// ---------------------------------------------------------------------------

export const wantsMcq = (text: string): boolean => /^\s*mcq\b/i.test(text || "");

export const hashQuestion = (q: string): string => (q || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const mcqQuestionSchema = z.object({
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(200)).length(4),
  answerIndex: z.number().int().min(0).max(3),
  explanation: z.string().max(300).optional(),
});

export const mcqSchema = z.object({
  questions: z.array(mcqQuestionSchema).min(1).max(50),
});

export const DEFAULT_MCQ_COUNT = 10;
export const MAX_MCQ_COUNT = 50;

// Explicit amount: leading number ("15 photosynthesis") or "<n> questions".
// Anything else (e.g. "World War 2") is left untouched; default 10.
export const parseMcqCount = (topic: string): { count: number; cleanTopic: string } => {
  const leading = topic.match(/^\s*(\d{1,3})\b\s*/);
  if (leading) {
    const n = Math.min(MAX_MCQ_COUNT, Math.max(1, parseInt(leading[1], 10)));
    return { count: n, cleanTopic: topic.replace(/^\s*\d{1,3}\b\s*/, "").trim() || topic.trim() };
  }
  const inline = topic.match(/\b(\d{1,3})\s+questions?\b/i);
  if (inline) {
    const n = Math.min(MAX_MCQ_COUNT, Math.max(1, parseInt(inline[1], 10)));
    return { count: n, cleanTopic: topic.replace(/\b\d{1,3}\s+questions?\b/i, "").replace(/\s+/g, " ").trim() || topic.trim() };
  }
  return { count: DEFAULT_MCQ_COUNT, cleanTopic: topic };
};

export type McqQuestion = z.infer<typeof mcqQuestionSchema>;
export type McqQuiz = { round: number; topic: string; questions: McqQuestion[] };

/** Merge incoming questions into target: drops empties, intra-batch dupes
 *  and bank dupes (normalized compare), capped at `count`. Mutates + returns
 *  target. Exported for unit testing the exact-count enforcement. */
export const mergeMcqQuestions = (
  target: McqQuestion[],
  incoming: McqQuestion[] | null,
  count: number,
  bankSet: Set<string>,
  bypassExclusion: boolean,
): McqQuestion[] => {
  if (!incoming) return target;
  const seen = new Set(target.map((q) => hashQuestion(q.question)));
  for (const q of incoming) {
    if (target.length >= count) break;
    const h = hashQuestion(q.question);
    if (!h) continue;
    if (seen.has(h)) continue;
    if (!bypassExclusion && bankSet.has(h)) continue;
    seen.add(h);
    target.push(q);
  }
  return target;
};

export type McqReplyOpts = {
  assistantMessageId: string;
  conversationId: string;
  topic: string;
  selectedModel: string;
  askedBank: string[];
  round: number;
  // When set, quiz generation runs on the user's own provider key (BYOK)
  // instead of the server-configured OpenRouter key.
  byok?: ByokRequest;
  // Folder + chat custom prompts (already merged by the route): quiz
  // generation binds them like every other AI call.
  systemPrompt?: string;
};

const MCQ_REPEAT_BYPASS = /repeat|shuffle|again/i;

// Short continuation ("mcq next round" / "mcq continue" / "mcq more",
// optional count or "on <topic>" after it). The real topic resolves from the
// latest quiz in this conversation — the client only sends the short text.
const NEXT_ROUND_RE = /^(next round|continue|more)\b/i;

const ANSWER_SPREAD_LINE =
  `DISTRIBUTE the correct answers evenly across all four positions ` +
  `(roughly 25% A, 25% B, 25% C, 25% D, in random order per question) — ` +
  `never stack the correct answer in one position.`;

const PATTERN_VARIETY_LINE =
  `VARY the question patterns: definitions, real-world scenarios, ` +
  `comparisons, cause-and-effect, examples, applications — do not write ` +
  `every question with the same monotonous stem.`;

const JSON_FORMAT_LINE =
  `Reply with ONLY JSON in the form {"questions":[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"..."}]}. ` +
  `Keep each question <=300 characters, each option <=200 characters, explanation <=300 characters and optional. ` +
  `No markdown, no extra text.`;

const buildMcqPrompt = (
  topic: string,
  count: number,
  exclusion: string[],
  opts: { round?: number; continuation?: boolean } = {}
): string => {
  const { round = 1, continuation = false } = opts;
  const head = continuation
    ? `Round ${round} of the "${topic}" quiz: generate EXACTLY ${count} NEW questions. ` +
      `Earlier rounds are in our chat history — do not repeat any asked question. ` +
      `This is a strict requirement: your response must contain exactly ${count} questions — no more, no fewer. Count them before replying. ` +
      `Each question must have exactly 4 options with exactly one correct answer.`
    : `Generate EXACTLY ${count} multiple-choice quiz questions on the topic "${topic}". ` +
      `This is a strict requirement: your response must contain exactly ${count} questions — no more, no fewer. Count them before replying. ` +
      `Each question must have exactly 4 options with exactly one correct answer.`;
  const base = `${head} ${ANSWER_SPREAD_LINE} ${PATTERN_VARIETY_LINE} ${JSON_FORMAT_LINE}`;
  if (exclusion.length === 0) return base;
  return `${base} Do NOT repeat these questions: ${JSON.stringify(exclusion)}`;
};

/** Deterministic answer spread: rotate each question's options by
 *  (index + round), so even a model that always answers A yields an even
 *  A/B/C/D split. The correct option text always follows answerIndex.
 *  Exported for unit testing. */
export const spreadAnswerPositions = (
  questions: McqQuestion[],
  round: number
): McqQuestion[] =>
  questions.map((q, i) => {
    if (!Array.isArray(q.options) || q.options.length !== 4) return q;
    if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) return q;
    const offset = (((i + round) % 4) + 4) % 4;
    if (offset === 0) return q;
    const options = q.options.map((_, k) => q.options[(k - offset + 4) % 4]);
    return { ...q, options, answerIndex: (q.answerIndex + offset) % 4 };
  });

const stripCodeFences = (text: string): string =>
  (text || "")
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

/** Incremental question extractor for streamed generation: scans a partial
 *  JSON buffer for COMPLETE question objects (brace-matched, string-aware),
 *  validates each with the question schema, and returns them in order.
 *  Incomplete trailing objects yield nothing (yet) — call again as tokens
 *  arrive. Exported for unit testing. */
export const extractCompleteMcqQuestions = (buffer: string): McqQuestion[] => {
  const out: McqQuestion[] = [];
  // Only strip a LEADING fence — a trailing fence means the stream finished.
  const src = (buffer || "").replace(/^\s*```[a-zA-Z]*\s*/, "");
  let i = 0;
  const n = src.length;
  while (i < n) {
    const start = src.indexOf("{", i);
    if (start === -1) break;
    // Brace-match with string/escape awareness.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < n; j++) {
      const c = src[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) {
      // Unclosed from here to the buffer end (outer wrapper still open or
      // a question in flight) — step inside and keep scanning for complete
      // siblings instead of giving up on the whole tail.
      i = start + 1;
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(src.slice(start, end + 1));
      const single = mcqQuestionSchema.safeParse(parsed);
      if (single.success) {
        out.push(single.data);
        i = end + 1;
      } else {
        // Not a question (e.g. the outer {"questions":…} wrapper) — keep
        // scanning INSIDE it for nested question objects.
        i = start + 1;
      }
    } catch {
      // Unparseable span — step inside and keep scanning.
      i = start + 1;
    }
  }
  return out;
};

const parseMcqText = (text: string): McqQuestion[] | null => {
  const cleaned = stripCodeFences(text);
  if (!cleaned) return null;
  const tryZod = (raw: unknown): McqQuestion[] | null => {
    if (Array.isArray(raw)) {
      const parsed = mcqSchema.safeParse({ questions: raw });
      return parsed.success ? parsed.data.questions : null;
    }
    const parsed = mcqSchema.safeParse(raw);
    return parsed.success ? parsed.data.questions : null;
  };
  try {
    return tryZod(JSON.parse(cleaned));
  } catch {
    // fall through to object-extraction fallback
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return tryZod(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
  return null;
};

export const sendMcqReply = async (req: any, res: any, opts: McqReplyOpts) => {
  const { assistantMessageId, conversationId, topic, selectedModel, askedBank, round } = opts;
  const startedAt = Date.now();
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  const finishText = async (text: string) => {
    return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd, startedAt });
  };

  const cleanTopic = (topic || "").trim();
  if (!cleanTopic) {
    return finishText("Tell me a topic for the quiz — e.g. `mcq solar system`.");
  }

  // Next-round shortcut: the client sends only "mcq next round" — the topic
  // resolves from the latest quiz in this conversation (history binds the
  // context). Accepts an optional count ("mcq next round 5") or topic
  // ("mcq next round on photosynthesis").
  let roundTopic = cleanTopic;
  let continuation = false;
  let countOverride: number | null = null;
  const nrMatch = cleanTopic.match(NEXT_ROUND_RE);
  if (nrMatch) {
    continuation = true;
    const rest = cleanTopic
      .slice(nrMatch[0].length)
      .trim()
      .replace(/^on\s+/i, "");
    if (rest) {
      const parsed = parseMcqCount(rest);
      // parseMcqCount falls back to DEFAULT_MCQ_COUNT with the raw text as
      // topic when no number is present — only take the count when rest
      // actually carries one.
      if (/\d/.test(rest)) countOverride = parsed.count;
      if (parsed.cleanTopic && !/^\d+\s*$/.test(rest)) roundTopic = parsed.cleanTopic;
    }
    if (roundTopic === cleanTopic) {
      const recent = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      const lastQuiz = recent
        .map((r) => (r as unknown as { quiz?: unknown }).quiz as McqQuiz | null | undefined)
        .find(
          (q): q is McqQuiz =>
            !!q && typeof q.topic === "string" && Array.isArray(q.questions)
        );
      if (!lastQuiz) {
        return finishText("Start a quiz first — e.g. `mcq solar system` — then say `mcq next round`.");
      }
      roundTopic = lastQuiz.topic;
    }
  }

  try {
    const bypassExclusion = MCQ_REPEAT_BYPASS.test(cleanTopic);
    const bankList: string[] = Array.isArray(askedBank)
      ? askedBank.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    // Bank stores question texts (slice 0,120 chars each, max 30) so the model
    // can actually avoid repeats; hashes are opaque and useless in a prompt.
    const exclusion: string[] = bypassExclusion
      ? []
      : bankList.slice(0, 30).map((q) => q.slice(0, 120));
    const { count: parsedCount, cleanTopic: countedTopic } = parseMcqCount(
      continuation ? roundTopic : cleanTopic
    );
    const count = countOverride ?? parsedCount;
    const topicForPrompt = continuation ? roundTopic : countedTopic || cleanTopic;

    const attemptOnce = async (askCount: number, askExclusion: string[]): Promise<McqQuestion[] | null> => {
      const askPrompt = buildMcqPrompt(topicForPrompt, askCount, askExclusion, {
        round,
        continuation,
      });
      const tuning = typeof opts.systemPrompt === "string" ? opts.systemPrompt.trim() : "";
      const askMaxTokens = Math.min(8000, Math.max(2000, askCount * 250));
      // BYOK: ask the user's provider directly (same prompt + parsing).
      if (opts.byok) {
        const text = await callByokText(opts.byok, tuning ? `${tuning}\n\n${askPrompt}` : askPrompt, {
          maxTokens: askMaxTokens,
          temperature: 0.7,
        });
        return text ? parseMcqText(text) : null;
      }
      try {
        const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": env.APP_ORIGIN,
            "X-Title": "ChatUI",
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: tuning
              ? [{ role: "system", content: tuning }, { role: "user", content: askPrompt }]
              : [{ role: "user", content: askPrompt }],
            max_tokens: Math.min(8000, Math.max(2000, askCount * 250)),
            temperature: 0.7,
          }),
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) return null;
        const json = (await response.json()) as any;
        const text: string = json?.choices?.[0]?.message?.content ?? "";
        return parseMcqText(text);
      } catch {
        return null;
      }
    };

    // Merge helper: dedupe model-returned dupes + bank dupes (normalize
    // compare). Returns the merged list capped at `count`.
    const bankSet = new Set(bankList.map(hashQuestion));
    const mergeInto = (target: McqQuestion[], incoming: McqQuestion[] | null): McqQuestion[] =>
      mergeMcqQuestions(target, incoming, count, bankSet, bypassExclusion);

    const displayTopic = continuation ? roundTopic : cleanTopic;

    // Progressive render: push the growing question list to the client the
    // moment each new question completes (cumulative `quiz` events replace
    // the list, so questions appear one by one as tokens arrive). Best
    // effort — a failed emit never fails the turn.
    const emitProgress = async (list: McqQuestion[]): Promise<void> => {
      if (list.length === 0 || res.writableEnded || res.destroyed) return;
      const snap: McqQuiz = {
        round,
        topic: displayTopic,
        questions: spreadAnswerPositions(list.slice(0, count), round),
      };
      try {
        await (prisma.message.update as any)({
          where: { id: assistantMessageId },
          data: { quiz: snap },
        });
      } catch {
        // persist is best-effort mid-stream; the final write still lands
      }
      sendEvent("quiz", { messageId: assistantMessageId, quiz: snap });
    };

    // Streaming attempt: questions emit progressively as they complete.
    // Merges into `fresh` (bank/exclusion rules apply per question) and
    // returns it — possibly partial when the transport dies mid-stream.
    // Returns null when streaming itself failed (caller falls back to the
    // single-shot path below), or when the BYOK kind isn't OpenAI-shaped
    // (Gemini/Anthropic keep single-shot).
    const attemptStream = async (
      askCount: number,
      askExclusion: string[],
      fresh: McqQuestion[]
    ): Promise<McqQuestion[] | null> => {
      const askPrompt = buildMcqPrompt(topicForPrompt, askCount, askExclusion, {
        round,
        continuation,
      });
      const tuning = typeof opts.systemPrompt === "string" ? opts.systemPrompt.trim() : "";
      const askMaxTokens = Math.min(8000, Math.max(2000, askCount * 250));
      let url: string;
      let headers: Record<string, string>;
      let body: Record<string, unknown>;
      if (opts.byok) {
        if (opts.byok.provider.kind !== "openai") return null;
        url = `${opts.byok.provider.baseUrl}/chat/completions`;
        headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.byok.apiKey}`,
          ...(opts.byok.provider.chatHeaders ?? {}),
        };
        body = {
          model: opts.byok.model,
          messages: tuning
            ? [{ role: "system", content: tuning }, { role: "user", content: askPrompt }]
            : [{ role: "user", content: askPrompt }],
          max_tokens: askMaxTokens,
          temperature: 0.7,
          stream: true,
        };
      } else {
        url = `${env.OPENROUTER_BASE_URL}/chat/completions`;
        headers = {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": env.APP_ORIGIN,
          "X-Title": "ChatUI",
        };
        body = {
          model: selectedModel,
          messages: tuning
            ? [{ role: "system", content: tuning }, { role: "user", content: askPrompt }]
            : [{ role: "user", content: askPrompt }],
          max_tokens: askMaxTokens,
          temperature: 0.7,
          stream: true,
        };
      }
      const seen = fresh.length;
      let full = "";
      let failed = false;
      const onDelta = (delta: string): void => {
        full += delta;
        // Re-parse the whole buffer per delta; merge dedupes by question
        // hash, so only genuinely new questions grow the list and emit.
        const before = fresh.length;
        mergeMcqQuestions(fresh, extractCompleteMcqQuestions(full), count, bankSet, bypassExclusion);
        if (fresh.length > before && fresh.length > seen) {
          void emitProgress(fresh);
        }
      };
      const pump = (chunk: string): void => {
        for (const line of chunk.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.replace(/^data:\s*/, "");
          if (!data || data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) onDelta(delta);
          } catch {
            // skip malformed chunks
          }
        }
      };
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch {
        return null;
      }
      if (!response.ok || !response.body) return null;
      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (res.writableEnded || res.destroyed) {
            failed = true;
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() || "";
          pump(parts.join("\n"));
        }
        const tail = `${buffer}${decoder.decode()}`.trim();
        if (tail && !failed) pump(tail);
      } catch {
        // Transport died mid-stream: keep whatever completed so far.
      }
      if (failed) return fresh.length > 0 ? fresh : null;
      return fresh.length > 0 ? fresh : null;
    };

    const streamedFresh: McqQuestion[] = [];
    let fetched: McqQuestion[] | null = await attemptStream(count, exclusion, streamedFresh);
    if (!fetched || fetched.length === 0) {
      // Streaming failed or yielded nothing: single-shot fallback (also
      // covers non-OpenAI BYOK kinds), then the existing retry-once.
      fetched = await attemptOnce(count, exclusion);
    }
    if (!fetched) {
      // Retry ONCE on invalid JSON / transient failure.
      fetched = await attemptOnce(count, exclusion);
    }
    if (!fetched || fetched.length === 0) {
      return finishText(`Sorry, I couldn't generate a quiz on "${displayTopic}" right now. Please try again.`);
    }

    const deduped: McqQuestion[] = mergeInto([], fetched);

    // Top-up loop: models often return fewer than asked, so explicitly
    // request exactly the missing remainder (excluding what we already
    // have) until the user's requested count is met.
    let topUps = 0;
    while (deduped.length < count && topUps < 2) {
      topUps += 1;
      const remaining = count - deduped.length;
      const gotSoFar = deduped.map((q) => q.question.slice(0, 120));
      const more = await attemptOnce(remaining, [...exclusion, ...gotSoFar]);
      if (!more || more.length === 0) break;
      const before = deduped.length;
      mergeInto(deduped, more);
      if (deduped.length === before) break; // no fresh questions — stop looping
      // Top-ups land after the stream: emit so late questions still appear
      // immediately instead of only in the final event below.
      void emitProgress(deduped);
    }
    if (deduped.length === 0) {
      return finishText(`Sorry, I couldn't generate fresh questions on "${displayTopic}" right now. Please try again.`);
    }

    const quiz: McqQuiz = {
      round,
      topic: displayTopic,
      questions: spreadAnswerPositions(deduped.slice(0, count), round),
    };

    await (prisma.message.update as any)({
      where: { id: assistantMessageId },
      data: { content: "", quiz, status: "COMPLETE", model: selectedModel, durationMs: Date.now() - startedAt },
    });

    // Append new question texts to conversation quizAsked (dedupe, cap 200).
    // Re-read the row so concurrent quiz turns don't clobber each other.
    try {
      const fresh = await (prisma.conversation.findUnique as any)({ where: { id: conversationId } });
      const existingRaw = (fresh as any)?.quizAsked;
      const existing: string[] = Array.isArray(existingRaw)
        ? existingRaw.filter((v: unknown): v is string => typeof v === "string")
        : bankList;
      const merged: string[] = [...existing];
      const mergedSet = new Set(existing.map(hashQuestion));
      for (const q of quiz.questions) {
        const h = hashQuestion(q.question);
        if (!h || mergedSet.has(h)) continue;
        mergedSet.add(h);
        merged.push(q.question);
      }
      const capped = merged.length > 200 ? merged.slice(-200) : merged;
      await (prisma.conversation.update as any)({
        where: { id: conversationId },
        data: { quizAsked: capped, updatedAt: new Date() },
      });
    } catch {
      // Fallback: best-effort merge from the passed-in bank.
      try {
        const merged: string[] = [...bankList];
        const mergedSet = new Set(bankList.map(hashQuestion));
        for (const q of quiz.questions) {
          const h = hashQuestion(q.question);
          if (!h || mergedSet.has(h)) continue;
          mergedSet.add(h);
          merged.push(q.question);
        }
        const capped = merged.length > 200 ? merged.slice(-200) : merged;
        await (prisma.conversation.update as any)({
          where: { id: conversationId },
          data: { quizAsked: capped, updatedAt: new Date() },
        });
      } catch {
        await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      }
    }

    sendEvent("quiz", { messageId: assistantMessageId, quiz });
    sendEvent("done", { messageId: assistantMessageId, usage: {}, durationMs: Date.now() - startedAt });
    // NO followups call for quiz turns.
    return safeEnd();
  } catch (err: any) {
    logger.error({ err }, "MCQ reply error");
    return finishText(`Sorry, I couldn't generate a quiz on "${cleanTopic}" right now. Please try again.`);
  }
};
