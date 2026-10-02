// One-shot (non-streaming) BYOK completion helper — shared by the follow-up
// generator and the MCQ quiz builder when the turn runs on a user's own
// provider key. The key is used for this call only; never stored or logged.
import type { ByokRequest } from "../../lib/byok";
import { BYOK_USER_AGENT } from "../../lib/byok";
import { byokErrorMessage } from "./byokRequest";

const FOLLOWUP_STYLE_TIMEOUT_MS = 90000;
const VERIFY_TEST_TIMEOUT_MS = 25000;
const VERIFY_TEST_PROMPT = "Reply with exactly: ok";

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
            "User-Agent": BYOK_USER_AGENT,
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
          "User-Agent": BYOK_USER_AGENT,
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
        "User-Agent": BYOK_USER_AGENT,
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

export type ByokInferenceTest = {
  ok: boolean;
  status: number;
  model: string;
  message: string;
  text?: string;
};

// Verify-key probe: sends ONE tiny real completion ("Reply with exactly: ok")
// to the provider with the user's key and reports the exact outcome. Unlike
// /validate (which only lists /models), this proves inference actually works
// — including provider-side states a model list can't reveal (out of balance,
// upstream billing failures, dead models). The key is used for this call
// only; never stored or logged.
export const testByokInference = async (
  byok: ByokRequest,
  timeoutMs = VERIFY_TEST_TIMEOUT_MS
): Promise<ByokInferenceTest> => {
  const { provider, model, apiKey } = byok;
  const fail = (status: number, errorText: string): ByokInferenceTest => ({
    ok: false,
    status,
    model,
    message: byokErrorMessage(provider.name, status, errorText),
  });
  try {
    if (provider.kind === "gemini") {
      const response = await fetch(
        `${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "User-Agent": BYOK_USER_AGENT,
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: VERIFY_TEST_PROMPT }] }],
            generationConfig: { maxOutputTokens: 64 },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
      if (!response.ok) return fail(response.status, await response.text().catch(() => ""));
      const json = (await response.json().catch(() => null)) as any;
      if (json?.error) return fail(Number(json.error?.code) || 502, json.error?.message ?? "Unknown error");
      const parts = json?.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts.filter((p: any) => !p?.thought && typeof p?.text === "string").map((p: any) => p.text as string).join("")
        : "";
      if (!text) return fail(502, "The provider returned an empty reply.");
      return { ok: true, status: 200, model, message: `${provider.name} answered the test message.`, text };
    }

    if (provider.kind === "anthropic") {
      const response = await fetch(`${provider.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "User-Agent": BYOK_USER_AGENT,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages: [{ role: "user", content: VERIFY_TEST_PROMPT }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return fail(response.status, await response.text().catch(() => ""));
      const json = (await response.json().catch(() => null)) as any;
      if (json?.type === "error") return fail(502, json?.error?.message ?? "Unknown error");
      const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
      const text = blocks
        .filter((b) => b?.type === "text" && typeof b?.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (!text) return fail(502, "The provider returned an empty reply.");
      return { ok: true, status: 200, model, message: `${provider.name} answered the test message.`, text };
    }

    // Minimal body on purpose (no max_tokens/temperature): strict gateways
    // 422 on parameters their models don't accept.
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "User-Agent": BYOK_USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(provider.chatHeaders ?? {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: VERIFY_TEST_PROMPT }],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return fail(response.status, await response.text().catch(() => ""));
    const json = (await response.json().catch(() => null)) as any;
    if (json?.error) return fail(Number(json.error?.code) || 502, json.error?.message ?? "Unknown error");
    const msg = json?.choices?.[0]?.message;
    const text =
      typeof msg?.content === "string"
        ? msg.content
        : Array.isArray(msg?.content)
          ? msg.content.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text as string).join("")
          : "";
    if (!text) return fail(502, "The provider returned an empty reply.");
    return { ok: true, status: 200, model, message: `${provider.name} answered the test message.`, text };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || /abort|timeout/i.test(err?.message ?? "");
    return fail(0, timedOut ? "The provider did not answer in time." : err?.message || "Request failed");
  }
};
