import { env } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { prisma } from "../../../lib/prisma";
import {
  getConnectorTokens,
  saveConnectorTokens,
} from "../tokenStore";

export const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
export const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
export const CANVA_REVOKE_URL = "https://api.canva.com/rest/v1/oauth/revoke";
export const CANVA_MCP_URL = env.CANVA_MCP_URL;

export const canvaOAuthConfigured = (): boolean =>
  Boolean(env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET && env.CANVA_REDIRECT_URI);

const basicAuthHeader = (): string => {
  const creds = Buffer.from(
    `${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`,
    "utf8"
  ).toString("base64");
  return `Basic ${creds}`;
};

type CanvaTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

// Single-use refresh tokens: Canva rotates the refresh token on every
// refresh, so the stored pair is replaced atomically on success.
export const refreshCanvaTokens = async (
  userId: string
): Promise<string | null> => {
  const stored = await getConnectorTokens(userId, "canva");
  if (!stored?.refreshToken) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    const res = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      logger.warn(
        { userId, status: res.status },
        "Canva token refresh rejected"
      );
      return null;
    }
    const json = (await res.json()) as CanvaTokenResponse;
    if (!json.access_token) return null;
    await saveConnectorTokens(userId, "canva", {
      accessToken: json.access_token,
      // Absent refresh_token means keep the stored one (never blank it).
      refreshToken: json.refresh_token ?? null,
      scope: json.scope ?? stored.scope,
      expiresInSec: typeof json.expires_in === "number" ? json.expires_in : null,
    });
    // Re-read to return the exact persisted access token.
    const fresh = await getConnectorTokens(userId, "canva");
    return fresh?.accessToken ?? null;
  } catch (err) {
    logger.error({ err, userId }, "Canva token refresh failed");
    return null;
  }
};

export const revokeCanvaToken = async (token: string): Promise<void> => {
  try {
    const body = new URLSearchParams({ token });
    await fetch(CANVA_REVOKE_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (err) {
    // Best-effort: local state is deleted regardless.
    logger.warn({ err }, "Canva token revoke request failed");
  }
};

export const pruneExpiredOAuthStates = async (): Promise<void> => {
  try {
    await prisma.connectorOAuthState.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  } catch {
    // best-effort housekeeping
  }
};
