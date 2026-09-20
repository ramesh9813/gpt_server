// Follow-up question generation — split from chat.service.ts. No logic changes.
import { env } from "../../lib/config";

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

export const generateFollowups = async (model: string, answer: string): Promise<string[]> => {
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
