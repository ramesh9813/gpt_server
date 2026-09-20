// MCQ quiz turn — split from chat.service.ts. No logic changes.
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { sseHead, sseSend, sseEnd, finishTextReply } from "./sse";

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
  questions: z.array(mcqQuestionSchema).min(1).max(10),
});

export type McqQuestion = z.infer<typeof mcqQuestionSchema>;
export type McqQuiz = { round: number; topic: string; questions: McqQuestion[] };

export type McqReplyOpts = {
  assistantMessageId: string;
  conversationId: string;
  topic: string;
  selectedModel: string;
  askedBank: string[];
  round: number;
};

const MCQ_REPEAT_BYPASS = /repeat|shuffle|again/i;

const buildMcqPrompt = (topic: string, exclusion: string[]): string => {
  const base =
    `Generate 10 multiple-choice quiz questions on the topic "${topic}". ` +
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
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  const finishText = async (text: string) => {
    return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
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
    const prompt = buildMcqPrompt(cleanTopic, exclusion);

    const attemptOnce = async (): Promise<McqQuestion[] | null> => {
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
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2000,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) return null;
        const json = (await response.json()) as any;
        const text: string = json?.choices?.[0]?.message?.content ?? "";
        return parseMcqText(text);
      } catch {
        return null;
      }
    };

    let fetched: McqQuestion[] | null = await attemptOnce();
    if (!fetched) {
      // Retry ONCE on invalid JSON / transient failure.
      fetched = await attemptOnce();
    }
    if (!fetched || fetched.length === 0) {
      return finishText(`Sorry, I couldn't generate a quiz on "${cleanTopic}" right now. Please try again.`);
    }

    // Filter model-returned dupes + bank dupes (normalize compare). When the
    // topic asks for repeat/shuffle/again, bank exclusion is bypassed but
    // intra-batch dupes are still removed. No second LLM call: accept fewer.
    const bankSet = new Set(bankList.map(hashQuestion));
    const seen = new Set<string>();
    const deduped: McqQuestion[] = [];
    for (const q of fetched) {
      const h = hashQuestion(q.question);
      if (!h) continue;
      if (seen.has(h)) continue;
      if (!bypassExclusion && bankSet.has(h)) continue;
      seen.add(h);
      deduped.push(q);
      if (deduped.length >= 10) break;
    }
    if (deduped.length === 0) {
      return finishText(`Sorry, I couldn't generate fresh questions on "${cleanTopic}" right now. Please try again.`);
    }

    const quiz: McqQuiz = { round, topic: cleanTopic, questions: deduped.slice(0, 10) };

    await (prisma.message.update as any)({
      where: { id: assistantMessageId },
      data: { content: "", quiz, status: "COMPLETE", model: selectedModel },
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
    sendEvent("done", { messageId: assistantMessageId, usage: {} });
    // NO followups call for quiz turns.
    return safeEnd();
  } catch (err: any) {
    console.error("MCQ reply error:", err?.message || err);
    return finishText(`Sorry, I couldn't generate a quiz on "${cleanTopic}" right now. Please try again.`);
  }
};
