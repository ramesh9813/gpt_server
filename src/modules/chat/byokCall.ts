// One-shot (non-streaming) BYOK completion helper — shared by the follow-up
// generator and the MCQ quiz builder when the turn runs on a user's own
// provider key. The key is used for this call only; never stored or logged.
import type { ByokRequest } from "../../lib/byok";

const FOLLOWUP_STYLE_TIMEOUT_MS = 90000;

// Sends a single-turn prompt to the BYOK provider and returns plain text,
// or null on any error (callers already degrade gracefully).
export const callByokText = async (
  byok: ByokRequest,
  prompt: string,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string | null> => {
  const { provider, model, apiKey } = byok;
  const maxTokens = opts.maxTokens ?? 150;
  try {
    if (provider.kind === "gemini") {
      const response = await fetch(
        `${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: Math.max(maxTokens, 1024), // gemini counts thoughts here too
              ...(opts.temperature !== undefined
                ? { temperature: opts.temperature }
                : {}),
            },
          }),
          signal: AbortSignal.timeout(FOLLOWUP_STYLE_TIMEOUT_MS),
        }
      );
      if (!response.ok) return null;
      const json = (await response.json()) as any;
      const parts = json?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts
        .filter((p: any) => !p?.thought && typeof p?.text === "string")
        .map((p: any) => p.text as string)
        .join("");
      return text || null;
    }

    if (provider.kind === "anthropic") {
      const response = await fetch(`${provider.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: Math.max(maxTokens, 1024),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(FOLLOWUP_STYLE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const json = (await response.json()) as any;
      const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
      const text = blocks
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text as string)
        .join("");
      return text || null;
    }

    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(provider.chatHeaders ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
        stream: false,
      }),
      signal: AbortSignal.timeout(FOLLOWUP_STYLE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as any;
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    return text || null;
  } catch {
    return null;
  }
};
