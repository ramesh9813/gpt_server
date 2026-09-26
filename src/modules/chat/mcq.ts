// MCQ quiz turn — split from chat.service.ts. No logic changes.
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { sseHead, sseSend, sseEnd, finishTextReply } from "./sse";
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
};

const MCQ_REPEAT_BYPASS = /repeat|shuffle|again/i;

const buildMcqPrompt = (topic: string, count: number, exclusion: string[]): string => {
  const base =
    `Generate EXACTLY ${count} multiple-choice quiz questions on the topic "${topic}". ` +
    `This is a strict requirement: your response must contain exactly ${count} questions — no more, no fewer. Count them before replying. ` +
    `Each question must have exactly 4 options with exactly one correct answer. ` +
    `Reply with ONLY JSON in the form {"questions":[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"..."}]}. ` +
    `Keep each question <=300 characters, each option <=200 characters, explanation <=300 characters and optional. ` +
    `No markdown, no extra text.`;
  if (exclusion.length === 0) return base;
  return `${base} Do NOT repeat these questions: ${JSON.stringify(exclusion)}`;
};

const stripCodeFences = (text: string): string =>
  (text || "")
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

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
    const { count, cleanTopic: countedTopic } = parseMcqCount(cleanTopic);
    const topicForPrompt = countedTopic || cleanTopic;

    const attemptOnce = async (askCount: number, askExclusion: string[]): Promise<McqQuestion[] | null> => {
      const askPrompt = buildMcqPrompt(topicForPrompt, askCount, askExclusion);
      const askMaxTokens = Math.min(8000, Math.max(2000, askCount * 250));
      // BYOK: ask the user's provider directly (same prompt + parsing).
      if (opts.byok) {
        const text = await callByokText(opts.byok, askPrompt, {
          maxTokens: askMaxTokens,
          temperature: 0.3,
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
            messages: [{ role: "user", content: askPrompt }],
            max_tokens: Math.min(8000, Math.max(2000, askCount * 250)),
            temperature: 0.3,
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

    let fetched: McqQuestion[] | null = await attemptOnce(count, exclusion);
    if (!fetched) {
      // Retry ONCE on invalid JSON / transient failure.
      fetched = await attemptOnce(count, exclusion);
    }
    if (!fetched || fetched.length === 0) {
      return finishText(`Sorry, I couldn't generate a quiz on "${cleanTopic}" right now. Please try again.`);
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
    }
    if (deduped.length === 0) {
      return finishText(`Sorry, I couldn't generate fresh questions on "${cleanTopic}" right now. Please try again.`);
    }

    const quiz: McqQuiz = { round, topic: cleanTopic, questions: deduped.slice(0, count) };

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
    console.error("MCQ reply error:", err?.message || err);
    return finishText(`Sorry, I couldn't generate a quiz on "${cleanTopic}" right now. Please try again.`);
  }
};
