import { env } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { getConnectorTokens, saveConnectorTokens } from "../tokenStore";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";

export const googleOAuthConfigured = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);

const basicAuthHeader = (): string => {
  const creds = Buffer.from(
    `${env.GOOGLE_CLIENT_ID}:${env.GOOGLE_CLIENT_SECRET}`,
    "utf8"
  ).toString("base64");
  return `Basic ${creds}`;
};

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

// Google refresh tokens are long-lived (no rotation): the stored pair is
// replaced atomically on success, keeping the old refresh token when the
// response carries none (saveConnectorTokens already does exactly that).
export const refreshGoogleTokens = async (
  userId: string
): Promise<string | null> => {
  const stored = await getConnectorTokens(userId, "google");
  if (!stored?.refreshToken) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.warn(
        { userId, status: res.status },
        "Google token refresh rejected"
      );
      return null;
    }
    const json = (await res.json()) as GoogleTokenResponse;
    if (!json.access_token) return null;
    await saveConnectorTokens(userId, "google", {
      accessToken: json.access_token,
      // Absent refresh_token means keep the stored one (never blank it).
      refreshToken: json.refresh_token ?? null,
      scope: json.scope ?? stored.scope,
      expiresInSec: typeof json.expires_in === "number" ? json.expires_in : null,
    });
    // Re-read to return the exact persisted access token.
    const fresh = await getConnectorTokens(userId, "google");
    return fresh?.accessToken ?? null;
  } catch (err) {
    logger.error({ err, userId }, "Google token refresh failed");
    return null;
  }
};

export const revokeGoogleToken = async (token: string): Promise<void> => {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // Best-effort: local state is deleted regardless.
    logger.warn({ err }, "Google token revoke request failed");
  }
};
