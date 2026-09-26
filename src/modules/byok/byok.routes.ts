import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import {
  fetchByokModels,
  getByokProvider,
  isByokKeyFormatSupported,
} from "../../lib/byok";

const router = Router();

const validateSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).max(600),
});

// POST /api/byok/validate — checks the shape of a user-supplied key against the
// selected provider and, when it parses, tries a live /models call so the
// client dropdown can list models this key can actually use. The key is used
// for this single check only; nothing is stored server-side.
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
      const models = await fetchByokModels(provider, trimmedKey);
      return res.json({
        success: true,
        data: {
          supported: true,
          verified: true,
          models,
          message: `${provider.name} key verified.`,
        },
      });
    } catch (err: any) {
      const status = err?.status;
      if (status === 401 || status === 403) {
        return res.json({
          success: true,
          data: {
            supported: false,
            verified: false,
            models: [],
            message: `${provider.name} rejected this key.`,
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

export default router;
