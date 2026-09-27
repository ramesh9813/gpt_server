import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import {
  fetchByokModels,
  firewallChallengeMessage,
  getByokProvider,
  isByokKeyFormatSupported,
} from "../../lib/byok";

const router = Router();

const validateSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).max(600),
});

const modelsSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().max(600).optional(),
});

// POST /api/byok/validate — checks the shape of a user-supplied key against the
// selected provider and, when it parses, tries a live /models call to confirm
// the key actually works. The key is used for this single check only; nothing
// is stored server-side.
router.post(
  "/validate",
  requireAuth,
  validateBody(validateSchema),
  async (req, res) => {
    const { provider: providerRaw, apiKey } = req.body as z.infer<
      typeof validateSchema
    >;
    const provider = getByokProvider(providerRaw);
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PROVIDER", message: "Unknown provider." },
      });
    }

    const trimmedKey = apiKey.trim();
    if (!isByokKeyFormatSupported(provider, trimmedKey)) {
      return res.json({
        success: true,
        data: {
          supported: false,
          verified: false,
          models: [],
          message: `This doesn't look like a ${provider.name} key (expected ${provider.keyHint}).`,
        },
      });
    }

    try {
      const catalog = await fetchByokModels(provider, trimmedKey);
      return res.json({
        success: true,
        data: {
          supported: true,
          verified: true,
          models: catalog.models,
          freeIds: catalog.freeIds,
          message: `${provider.name} key verified.`,
        },
      });
    } catch (err: any) {
      const status = err?.status;
      // Firewall challenge (HTML): the key was never evaluated — say so
      // instead of blaming the key.
      if (err?.challenged) {
        return res.json({
          success: true,
          data: {
            supported: true,
            verified: false,
            models: [],
            message: firewallChallengeMessage(provider.name),
          },
        });
      }
      if (status === 429) {
        return res.json({
          success: true,
          data: {
            supported: true,
            verified: false,
            models: [],
            message: `${provider.name} is rate limiting right now — wait a moment and verify again.`,
          },
        });
      }
      if (status === 402) {
        return res.json({
          success: true,
          data: {
            supported: true,
            verified: false,
            models: [],
            message: `${provider.name} accepted the key but the account is out of balance.`,
          },
        });
      }
      if (status === 401 || status === 403) {
        return res.json({
          success: true,
          data: {
            supported: false,
            verified: false,
            models: [],
            message:
              status === 403
                ? `${provider.name} rejected this key or the key lacks the models permission (check its scopes).`
                : `${provider.name} rejected this key.`,
          },
        });
      }
      // Network/parse failure: format is fine, we just couldn't confirm live.
      return res.json({
        success: true,
        data: {
          supported: true,
          verified: false,
          models: [],
          message:
            "Key format looks supported, but the provider could not be reached to verify it.",
        },
      });
    }
  }
);

// POST /api/byok/models — returns the provider's LIVE model catalog so the
// client dropdowns are never hardcoded. Providers with `keylessModels` list
// without a key; the rest need a (well-formed) key in the body. On failure a
// soft 200 with an empty list lets the client fall back to its small bundled
// list — the key is used for this call only and never stored.
router.post(
  "/models",
  requireAuth,
  validateBody(modelsSchema),
  async (req, res) => {
    const { provider: providerRaw, apiKey } = req.body as z.infer<
      typeof modelsSchema
    >;
    const provider = getByokProvider(providerRaw);
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PROVIDER", message: "Unknown provider." },
      });
    }

    const trimmedKey = (apiKey ?? "").trim();
    if (trimmedKey && !isByokKeyFormatSupported(provider, trimmedKey)) {
      return res.json({
        success: true,
        data: {
          models: [],
          keyRequired: false,
          message: `This doesn't look like a ${provider.name} key (expected ${provider.keyHint}).`,
        },
      });
    }

    try {
      const catalog = await fetchByokModels(provider, trimmedKey);
      return res.json({
        success: true,
        data: { models: catalog.models, freeIds: catalog.freeIds, keyRequired: false },
      });
    } catch (err: any) {
      const status = err?.status;
      if (err?.challenged) {
        return res.json({
          success: true,
          data: {
            models: [],
            keyRequired: false,
            message: firewallChallengeMessage(provider.name),
          },
        });
      }
      if (status === 401 || status === 403 || (status === 400 && !trimmedKey)) {
        return res.json({
          success: true,
          data: {
            models: [],
            keyRequired: !trimmedKey,
            message:
              status === 403
                ? `${provider.name} rejected the key or the key lacks the models permission (check its scopes).`
                : status === 401 && trimmedKey
                  ? `${provider.name} rejected this key.`
                  : undefined,
          },
        });
      }
      if (status === 402) {
        return res.json({
          success: true,
          data: {
            models: [],
            keyRequired: false,
            message: `${provider.name} accepted the key but the account is out of balance.`,
          },
        });
      }
      if (status === 429) {
        return res.json({
          success: true,
          data: {
            models: [],
            keyRequired: false,
            message: `${provider.name} is rate limiting right now — wait a moment and retry.`,
          },
        });
      }
      return res.json({
        success: true,
        data: {
          models: [],
          keyRequired: false,
          message: `${provider.name} did not return a model list right now.`,
        },
      });
    }
  }
);

export default router;
