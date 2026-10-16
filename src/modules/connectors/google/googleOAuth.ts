import crypto from "crypto";
import { Request, Response } from "express";
import { prisma } from "../../../lib/prisma";
import { env } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { hashToken } from "../../../lib/auth";
import { saveConnectorTokens, getConnectorTokens, deleteConnectorTokens } from "../tokenStore";
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  googleOAuthConfigured,
  revokeGoogleToken,
} from "./googleTokens";
import { pruneExpiredOAuthStates } from "../canva/canvaTokens";

const STATE_TTL_MS = 10 * 60 * 1000;

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const ALLOWED_ORIGINS = new Set(
  env.APP_ORIGIN.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean)
);

const appReturnUrl = (params: string): string => {
  const raw = env.APP_ORIGIN.split(",")[0]?.trim().replace(/\/+$/, "") || "";
  const origin = ALLOWED_ORIGINS.has(raw) ? raw : [...ALLOWED_ORIGINS][0] || "";
  return `${origin}/account?${params}`;
};

// GET /api/connectors/google/authorize — logged-in user only (cookie or
// Bearer; the client navigates here with window.location.href so the
// httpOnly session cookie authenticates the hop). Issues PKCE + state,
// stores them server-side, then 302s to Google's login/consent screen.
export const googleAuthorizeHandler = async (req: Request, res: Response) => {
  if (!googleOAuthConfigured()) {
    return res.status(500).json({
      success: false,
      error: { code: "CONFIG_ERROR", message: "Google connector is not configured on the server" },
    });
  }
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  const state = base64Url(crypto.randomBytes(32));

  await prisma.connectorOAuthState.create({
    data: {
      userId: req.user!.id,
      provider: "google",
      stateHash: hashToken(state),
      codeVerifier,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  void pruneExpiredOAuthStates();

  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", env.GOOGLE_SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("state", state);
  // Exact-match against a redirect URI registered in the Google console.
  url.searchParams.set("redirect_uri", env.GOOGLE_REDIRECT_URI);
  // Offline access returns a refresh token so the link survives; the
  // consent screen always shows so reconnects re-issue one if lost.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return res.redirect(302, url.toString());
};

// GET /api/connectors/google/callback — Google redirects here with
// ?code=&state=. State is single-use: consumed (deleted) before any token
// exchange. Never HTML-renders tokens; finishes with a redirect to the app.
export const googleCallbackHandler = async (req: Request, res: Response) => {
  const fail = (code: string) => res.redirect(302, appReturnUrl(`connector=google&error=${code}`));
  try {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) {
      logger.warn({ error }, "Google OAuth denied/errored");
      return fail("denied");
    }
    if (!code || !state) return fail("missing_params");

    // Atomic single-use consume: delete by stateHash returns the row or null.
    // A concurrent replay gets null and fails invalid_state.
    let row: { id: string; userId: string; provider: string; codeVerifier: string; expiresAt: Date } | null = null;
    try {
      row = await prisma.connectorOAuthState.delete({
        where: { stateHash: hashToken(state) },
      });
    } catch {
      row = null;
    }
    void pruneExpiredOAuthStates();
    if (!row || row.provider !== "google" || row.expiresAt.getTime() < Date.now()) {
      return fail("invalid_state");
    }

    if (!googleOAuthConfigured()) return fail("misconfigured");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: row.codeVerifier,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
    });
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${env.GOOGLE_CLIENT_ID}:${env.GOOGLE_CLIENT_SECRET}`,
          "utf8"
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, "Google code exchange rejected");
      return fail("exchange_failed");
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
    };
    if (!tokens.access_token) return fail("exchange_failed");

    await saveConnectorTokens(row.userId, "google", {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      scope: tokens.scope ?? env.GOOGLE_SCOPES,
      expiresInSec: typeof tokens.expires_in === "number" ? tokens.expires_in : null,
    });
    // Owner allowlist is for app roles only — connector availability is per-user.
    return res.redirect(302, appReturnUrl("connector=google&connected=1"));
  } catch (err) {
    logger.error({ err }, "Google OAuth callback failed");
    return fail("callback_failed");
  }
};

// POST /api/connectors/google/disconnect — best-effort provider revoke,
// then unconditional local delete.
export const googleDisconnectHandler = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const stored = await getConnectorTokens(userId, "google");
    if (stored?.refreshToken) {
      // Revoking the refresh token kills its lineage + user consent.
      await revokeGoogleToken(stored.refreshToken);
    } else if (stored?.accessToken) {
      await revokeGoogleToken(stored.accessToken);
    }
  } finally {
    await deleteConnectorTokens(userId, "google");
  }
  return res.json({ success: true, data: { connected: false } });
};
