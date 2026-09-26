import crypto from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/config";
import { logger } from "../../lib/logger";

export const CONNECTOR_PROVIDERS = ["canva"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const isConnectorProvider = (value: unknown): value is ConnectorProvider =>
  typeof value === "string" &&
  (CONNECTOR_PROVIDERS as readonly string[]).includes(value);

export type ConnectorTokens = {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | null;
};

// AES-256-GCM. Stored format: "v1:<ivHex>:<tagHex>:<dataHex>".
// The key must be 64 hex chars (32 bytes) in CONNECTOR_ENCRYPTION_KEY.
const resolveKey = (): Buffer => {
  const raw = (env.CONNECTOR_ENCRYPTION_KEY || "").trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  throw new Error(
    "CONNECTOR_ENCRYPTION_KEY must be 64 hex characters (generate with: openssl rand -hex 32)"
  );
};

export const isTokenEncryptionConfigured = (): boolean => {
  try {
    resolveKey();
    return true;
  } catch {
    return false;
  }
};

export const encryptToken = (plaintext: string): string => {
  const key = resolveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
};

export const decryptToken = (stored: string): string => {
  const key = resolveKey();
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported token cipher format");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(dataHex, "hex")).toString("utf8") +
    decipher.final().toString("utf8")
  );
};

export const saveConnectorTokens = async (
  userId: string,
  provider: ConnectorProvider,
  tokens: { accessToken: string; refreshToken?: string | null; scope?: string | null; expiresInSec?: number | null }
): Promise<void> => {
  await prisma.connectorToken.upsert({
    where: { userId_provider: { userId, provider } },
    create: {
      userId,
      provider,
      accessTokenCipher: encryptToken(tokens.accessToken),
      refreshTokenCipher: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      scope: tokens.scope ?? null,
      expiresAt:
        typeof tokens.expiresInSec === "number"
          ? new Date(Date.now() + tokens.expiresInSec * 1000)
          : null,
    },
    update: {
      accessTokenCipher: encryptToken(tokens.accessToken),
      // Canva rotates refresh tokens (single-use): only overwrite when the
      // response actually carries a new one, never blank a stored one.
      ...(tokens.refreshToken ? { refreshTokenCipher: encryptToken(tokens.refreshToken) } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope ?? null } : {}),
      ...(typeof tokens.expiresInSec === "number"
        ? { expiresAt: new Date(Date.now() + tokens.expiresInSec * 1000) }
        : {}),
    },
  });
};

export const getConnectorTokens = async (
  userId: string,
  provider: ConnectorProvider
): Promise<ConnectorTokens | null> => {
  const row = await prisma.connectorToken.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (!row) return null;
  try {
    return {
      accessToken: decryptToken(row.accessTokenCipher),
      refreshToken: row.refreshTokenCipher ? decryptToken(row.refreshTokenCipher) : null,
      scope: row.scope,
      expiresAt: row.expiresAt,
    };
  } catch (err) {
    // Wrong key / corrupt row: fail closed and log WITHOUT token material.
    logger.error(
      { err, userId, provider },
      "Connector token decrypt failed (check CONNECTOR_ENCRYPTION_KEY)"
    );
    return null;
  }
};

export const deleteConnectorTokens = async (
  userId: string,
  provider: ConnectorProvider
): Promise<void> => {
  await prisma.connectorToken.deleteMany({ where: { userId, provider } });
};

export const isAccessTokenExpired = (
  tokens: ConnectorTokens,
  skewMs = 60_000
): boolean => {
  if (!tokens.expiresAt) return false;
  return tokens.expiresAt.getTime() - skewMs <= Date.now();
};
