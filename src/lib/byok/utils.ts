import type { Response } from "express";
import type { ByokProvider } from "../byokTypes";

export const BYOK_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const isFirewallChallengeBody = (body: unknown): boolean => {
  if (typeof body !== "string" || body.length === 0) return false;
  return /<\s*!doctype|<\s*html|just a moment|challenges\.cloudflare|cf-challenge|attention required/i.test(body);
};

export const firewallChallengeMessage = (providerName: string): string =>
  `${providerName} is shielded by a network firewall (Cloudflare check) that blocked this server's request before it reached the API — not an API-key problem. Retry shortly; if it persists, the server's IP is flagged, so ask ${providerName} support to allow it or move the backend to a trusted network.`;

export const providerStatusError = async (
  response: Response
): Promise<Error & { status?: number; body?: string; challenged?: boolean }> => {
  const text = await (response as unknown as { text: () => Promise<string> }).text().catch(() => "");
  const err = new Error(`provider returned ${(response as any).status}`) as Error & {
    status?: number;
    body?: string;
    challenged?: boolean;
  };
  err.status = (response as any).status;
  err.body = text.slice(0, 2000);
  err.challenged = isFirewallChallengeBody(text);
  return err;
};

export const isByokKeyFormatSupported = (provider: ByokProvider, apiKey: string): boolean =>
  provider.keyPattern.test(apiKey.trim());
