import crypto from "crypto";
import { Request, Response } from "express";
import { prisma } from "../../../lib/prisma";
import { env } from "../../../lib/config";
import { logger } from "../../../lib/logger";
import { hashToken } from "../../../lib/auth";
import { saveConnectorTokens, getConnectorTokens, deleteConnectorTokens } from "../tokenStore";
import {
  CANVA_AUTHORIZE_URL,
  CANVA_TOKEN_URL,
  canvaOAuthConfigured,
  pruneExpiredOAuthStates,
  revokeCanvaToken,
} from "./canvaTokens";
import { closeUserConnection } from "./canvaMcp";

const STATE_TTL_MS = 10 * 60 * 1000;

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const appReturnUrl = (params: string): string => {
  const origin = env.APP_ORIGIN.split(",")[0]?.trim().replace(/\/+$/, "") || "";
  return `${origin}/account?${params}`;
};

// GET /api/connectors/canva/authorize — logged-in user only (cookie or
// Bearer; the client navigates here with window.location.href so the
// httpOnly session cookie authenticates the hop). Issues PKCE + state,
// stores them server-side, then 302s to Canva.
export const canvaAuthorizeHandler = async (req: Request, res: Response) => {
  if (!canvaOAuthConfigured()) {
    return res.status(500).json({
      success: false,
      error: { code: "CONFIG_ERROR", message: "Canva connector is not configured on the server" },
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
      provider: "canva",
      stateHash: hashToken(state),
      codeVerifier,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  void pruneExpiredOAuthStates();

  const url = new URL(CANVA_AUTHORIZE_URL);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", env.CANVA_SCOPES);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.CANVA_CLIENT_ID);
  url.searchParams.set("state", state);
  // Exact-match against a URL registered in the Canva developer portal.
  url.searchParams.set("redirect_uri", env.CANVA_REDIRECT_URI);
  return res.redirect(302, url.toString());
};

// GET /api/connectors/canva/callback — Canva redirects here with
// ?code=&state=. State is single-use: consumed (deleted) before any token
// exchange. Never HTML-renders tokens; finishes with a redirect to the app.
export const canvaCallbackHandler = async (req: Request, res: Response) => {
  const fail = (code: string) => res.redirect(302, appReturnUrl(`connector=canva&error=${code}`));
  try {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) {
      logger.warn({ error }, "Canva OAuth denied/errored");
      return fail("denied");
    }
    if (!code || !state) return fail("missing_params");

    const row = await prisma.connectorOAuthState.findUnique({
      where: { stateHash: hashToken(state) },
    });
    if (!row || row.provider !== "canva" || row.expiresAt.getTime() < Date.now()) {
      return fail("invalid_state");
    }
    // Single-use: delete BEFORE exchanging so a replayed callback is dead.
    await prisma.connectorOAuthState.delete({ where: { id: row.id } }).catch(() => null);
    void pruneExpiredOAuthStates();

    if (!canvaOAuthConfigured()) return fail("misconfigured");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: row.codeVerifier,
      redirect_uri: env.CANVA_REDIRECT_URI,
    });
    const tokenRes = await fetch(CANVA_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`,
          "utf8"
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status }, "Canva code exchange rejected");
      return fail("exchange_failed");
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!tokens.access_token) return fail("exchange_failed");

    await saveConnectorTokens(row.userId, "canva", {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      scope: tokens.scope ?? env.CANVA_SCOPES,
      expiresInSec: typeof tokens.expires_in === "number" ? tokens.expires_in : null,
    });
    // Owner allowlist is for app roles only — connector availability is per-user.
    return res.redirect(302, appReturnUrl("connector=canva&connected=1"));
  } catch (err) {
    logger.error({ err }, "Canva OAuth callback failed");
    return fail("callback_failed");
  }
};

// POST /api/connectors/canva/disconnect — best-effort provider revoke,
// then unconditional local delete + connection drop.
export const canvaDisconnectHandler = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  try {
    const stored = await getConnectorTokens(userId, "canva");
    if (stored?.refreshToken) {
      // Revoking the refresh token kills its lineage + user consent.
      await revokeCanvaToken(stored.refreshToken);
    } else if (stored?.accessToken) {
      await revokeCanvaToken(stored.accessToken);
    }
  } finally {
    await closeUserConnection(userId).catch(() => null);
    await deleteConnectorTokens(userId, "canva");
  }
  return res.json({ success: true, data: { connected: false } });
};
