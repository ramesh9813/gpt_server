import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { listOpenRouterModels, supportsImageGeneration } from "../../lib/openrouter";

// Vision: inline base64 dataURLs, no storage/S3. Keep small to fit 10mb JSON body.
export const MAX_IMAGES = 3;
export const MAX_IMAGE_STRING_LENGTH = 7 * 1024 * 1024; // ~7MB string each (~5MB binary + base64 overhead)
const IMAGE_PREFIX_REGEX = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/;

const imageDataUrlSchema = z
  .string()
  .max(MAX_IMAGE_STRING_LENGTH, "Each image must be under ~7MB")
  .refine((v) => IMAGE_PREFIX_REGEX.test(v.slice(0, 50)), {
    message: "images must be dataURL jpeg/png/webp/gif base64",
  })
  .refine((v) => v.length > 30, {
    message: "images must contain base64 payload",
  });

export const streamSchema = z
  .object({
    conversationId: z.string(),
    userMessage: z.string().min(1).max(8000).optional(),
    existingUserMessageId: z.string().optional(),
    images: z.array(imageDataUrlSchema).max(MAX_IMAGES).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    research: z.boolean().optional(),
  })
  .refine((data) => data.userMessage || data.existingUserMessageId || (data.images && data.images.length > 0), {
    message: "userMessage or existingUserMessageId or images is required",
  })
  .refine((data) => !(data.userMessage && data.existingUserMessageId), {
    message: "Provide either userMessage or existingUserMessageId",
  });

export type StreamRequestBody = z.infer<typeof streamSchema>;

export type OpenRouterTextPart = { type: "text"; text: string };
export type OpenRouterImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenRouterContent = string | Array<OpenRouterTextPart | OpenRouterImagePart>;
export type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: OpenRouterContent };

export const mapRole = (role: string): OpenRouterMessage["role"] => {
  if (role === "SYSTEM") return "system";
  if (role === "ASSISTANT") return "assistant";
  return "user";
};

export const buildUserContent = (text: string, images?: string[]): OpenRouterContent => {
  if (!images || images.length === 0) return text;
  const safeText = text && text.trim().length > 0 ? text : "Describe the attached image(s) in detail.";
  return [{ type: "text", text: safeText }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))];
};

export const getStoredImages = (msg: unknown): string[] => {
  const raw = (msg as { images?: unknown }).images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.startsWith("data:image/"));
};

// Avoid dumping multi-MB base64 into logs.
export const redactForLog = (messages: OpenRouterMessage[]) =>
  messages.map((m) => {
    if (typeof m.content === "string") return m;
    return {
      ...m,
      content: (m.content as Array<OpenRouterTextPart | OpenRouterImagePart>).map((p) =>
        p.type === "image_url"
          ? { type: p.type, image_url: { url: `[omitted dataURL length=${p.image_url.url.length}]` } }
          : p
      ),
    };
  });

const cleanQuestion = (v: string): string => {
  const bullets = String.raw`[-*\d.\s:;)\]]`;
  const quotes = "\u201c\u201d\u2018\u2019";
  const leading = new RegExp(`^${bullets}+`);
  const wrapping = new RegExp(`^[\"'${quotes}\`*]+|[\"'${quotes}\`*]+$`, "g");
  return v.trim().replace(leading, "").replace(wrapping, "").trim();
};

const parseFollowups = (text: string): string[] => {
  const cleaned = (text || "")
    .trim()
    // strip markdown fences some models wrap around the JSON
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!cleaned) return [];
  const candidates: unknown[] = [];
  const tryParse = (raw: string) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) candidates.push(...parsed);
      return true;
    } catch {
      return false;
    }
  };
  if (!tryParse(cleaned)) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) tryParse(match[0]);
  }
  let questions = candidates
    .filter((v): v is string => typeof v === "string")
    .map(cleanQuestion)
    .filter((v) => v.length > 0 && v.length <= 140);
  // Fallback for models that ignore the JSON instruction: one question per line.
  if (questions.length === 0) {
    questions = cleaned
      .split(/\r?\n+/)
      .map(cleanQuestion)
      .filter((v) => v.length > 10 && v.length <= 140);
  }
  // Last resort: split long prose on sentence boundaries.
  if (questions.length === 0 && cleaned.length > 20) {
    questions = cleaned
      .split(/(?<=[?!])\s+/)
      .map(cleanQuestion)
      .filter((v) => v.length > 10 && v.length <= 140);
  }
  return questions.slice(0, 3);
};

const generateFollowups = async (model: string, answer: string): Promise<string[]> => {
  const excerpt = (answer || "").trim().replace(/\s+/g, " ").slice(0, 2000);
  if (!excerpt) return [];
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
      messages: [
        {
          role: "user",
          content: `Suggest 3 short follow-up questions a user might ask next about this answer. Reply with ONLY a JSON array of strings, no other text. Answer: ${excerpt}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) return [];
  const json = (await response.json()) as any;
  const text: string = json?.choices?.[0]?.message?.content ?? "";
  return parseFollowups(text);
};

// Deep Research: dedicated research models (e.g. perplexity/sonar-deep-research,
// openai/o3-deep-research) search and synthesize autonomously. This prompt asks
// for a thorough, sourced report; max_tokens is raised since reports are long.
export const RESEARCH_SYSTEM_PROMPT =
  "You are a deep research analyst. Investigate the user's topic thoroughly using every source available to you. " +
  "Produce a comprehensive, well-structured report with clear headings, key findings up front, detailed analysis, " +
  "and a Sources section listing the URLs you relied on. Be factual, cite claims to sources, and note uncertainty " +
  "where sources disagree.";

const IMAGE_INTENT = /\b(generat\w*|creat\w*|draw\w*|paint\w*|design\w*|render\w*|mak\w*|produc\w*)\b.{0,50}\b(image|picture|photo|artwork|logo|illustration|avatar|banner|drawing|painting|wallpaper|icon)\b|\b(image|picture|photo|logo)\s+of\b|\bdraw\s+me\b/i;

export const wantsImageGeneration = (text: string): boolean =>
  IMAGE_INTENT.test(text || "");

export const sseHead = (res: any) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
};
export const sseSend = (res: any) => (event: string, data: unknown) => {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};
export const sseEnd = (res: any) => () => {
  if (!res.writableEnded && !res.destroyed) res.end();
};

// Shared finish: persist plain text on the assistant message + emit token/done.
// Extracted so sendImageReply / sendMcqReply / routes empty-topic path share it.
export const finishTextReply = async (
  _res: any,
  opts: {
    assistantMessageId: string;
    conversationId: string;
    selectedModel: string;
    text: string;
    sendEvent: (event: string, data: unknown) => void;
    safeEnd: () => void;
  }
) => {
  const { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd } = opts;
  await prisma.message.update({
    where: { id: assistantMessageId },
    data: { content: text, status: "COMPLETE", model: selectedModel },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  sendEvent("token", { delta: text });
  sendEvent("done", { messageId: assistantMessageId, usage: {} });
  return safeEnd();
};

// One-call variant for callers that have not started SSE yet (e.g. routes
// empty-topic guard). Does sseHead + finishTextReply.
export const sendSimpleTextFinish = async (
  _req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; selectedModel: string; text: string }
) => {
  const { assistantMessageId, conversationId, selectedModel, text } = opts;
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
};

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

// Image-generation turn: uses the selected model when it can emit images,
// otherwise answers with a plain-text capability notice. Images are saved
// on the assistant message (Message.images) so they persist + re-render.
export const sendImageReply = async (
  req: any,
  res: any,
  opts: { assistantMessageId: string; conversationId: string; prompt: string; selectedModel: string }
) => {
  const { assistantMessageId, conversationId, prompt, selectedModel } = opts;
  sseHead(res);
  const sendEvent = sseSend(res);
  const safeEnd = sseEnd(res);
  const finishText = async (text: string) => {
    return finishTextReply(res, { assistantMessageId, conversationId, selectedModel, text, sendEvent, safeEnd });
  };
  try {
    const catalog = await listOpenRouterModels().catch(() => []);
    if (!supportsImageGeneration(selectedModel, catalog)) {
      return finishText(
        `This model (\`${selectedModel}\`) has no image-generation capability, so I can't create pictures with it. Switch to an image-capable model (for example a gpt-image or Gemini image model) and ask again.`
      );
    }
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
        modalities: ["image", "text"],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) {
      return finishText(`Image generation failed (${response.status}). Please try again.`);
    }
    const json = (await response.json()) as any;
    const msg = json?.choices?.[0]?.message ?? {};
    const urls: string[] = Array.isArray(msg.images)
      ? msg.images.map((im: any) => im?.image_url?.url).filter((u: unknown): u is string => typeof u === "string" && u.startsWith("data:image/"))
      : [];
    const caption: string = typeof msg.content === "string" ? msg.content : "";
    if (urls.length === 0) {
      return finishText(caption || "The model did not return an image. Please try again.");
    }
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { content: caption, images: urls, status: "COMPLETE", model: selectedModel },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    sendEvent("images", { messageId: assistantMessageId, images: urls });
    sendEvent("done", { messageId: assistantMessageId, usage: {} });
    try {
      const followups = await generateFollowups(selectedModel, `Generated image for: ${prompt}. ${caption}`);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({ where: { id: assistantMessageId }, data: { followups } });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("Followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    console.error("Image reply error:", err?.message || err);
    return finishText("Image generation failed. Please try again.");
  }
};

export const streamOpenRouterCompletion = async (
  req: Request,
  res: Response,
  opts: { assistantMessageId: string; conversationId: string; messages: OpenRouterMessage[]; selectedModel: string; research?: boolean }
) => {
  const { assistantMessageId, conversationId, messages, selectedModel, research } = opts;
  if (!env.OPENROUTER_API_KEY) {
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: "OPENROUTER_API_KEY is not configured on the server." },
    });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ code: "CONFIG_ERROR", message: "OPENROUTER_API_KEY is not configured on the server. Please set it in your Render environment variables." })}\n\n`);
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  const sendEvent = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const safeEnd = () => {
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  let assistantContent = "";
  let lastPersistedLength = 0;
  let lastPersistedAt = Date.now();
  console.log("Sending messages to OpenRouter:", JSON.stringify(redactForLog(messages), null, 2));
  try {
    const requestBody: Record<string, unknown> = {
      model: selectedModel,
      messages: research
        ? [{ role: "system", content: RESEARCH_SYSTEM_PROMPT }, ...messages]
        : messages,
      stream: true,
    };
    if (research) {
      // Research reports are long; raise the ceiling when in research mode.
      requestBody.max_tokens = 8000;
    }
    const response = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.APP_ORIGIN,
        "X-Title": "ChatUI",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    console.log("OpenRouter Response Status:", response.status, response.statusText);
    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error("OpenRouter Error:", errorText);
      await prisma.message.update({ where: { id: assistantMessageId }, data: { status: "ERROR", error: errorText } });
      sendEvent("error", { code: "OPENROUTER_ERROR", message: `OpenRouter error: ${errorText}` });
      return safeEnd();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let usage: any = null;
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.replace(/^data:\s*/, "");
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            assistantContent += delta;
            sendEvent("token", { delta });
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // ignore malformed chunks
        }
      }
      const now = Date.now();
      if (assistantContent.length - lastPersistedLength >= 200 || now - lastPersistedAt > 1000) {
        lastPersistedLength = assistantContent.length;
        lastPersistedAt = now;
        await prisma.message.update({ where: { id: assistantMessageId }, data: { content: assistantContent } });
      }
    }
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: {
        content: assistantContent,
        status: "COMPLETE",
        model: selectedModel,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokenCount: usage?.total_tokens,
      },
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    sendEvent("done", { messageId: assistantMessageId, usage: usage || {} });
    // Best-effort follow-up questions (never fails the stream).
    try {
      const followups = await generateFollowups(selectedModel, assistantContent);
      if (followups.length > 0 && !res.writableEnded && !res.destroyed) {
        await prisma.message.update({
          where: { id: assistantMessageId },
          data: { followups },
        });
        sendEvent("followups", { messageId: assistantMessageId, followups });
      }
    } catch (err) {
      console.error("Followups error:", (err as any)?.message || err);
    }
    return safeEnd();
  } catch (err: any) {
    if (controller.signal.aborted) {
      await prisma.message.update({
        where: { id: assistantMessageId },
        data: { content: assistantContent, status: "COMPLETE", model: selectedModel },
      });
      await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return safeEnd();
    }
    console.error("Stream error:", err);
    await prisma.message.update({
      where: { id: assistantMessageId },
      data: { status: "ERROR", error: err?.message || "Stream error" },
    });
    sendEvent("error", { code: "STREAM_ERROR", message: "Streaming failed" });
    return safeEnd();
  }
};
