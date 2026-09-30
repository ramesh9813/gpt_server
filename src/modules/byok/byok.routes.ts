import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import {
  fetchByokModels,
  firewallChallengeMessage,
  isByokKeyFormatSupported,
} from "../../lib/byok";
import { getByokProviderAsync } from "../../lib/providers";

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
    const provider = await getByokProviderAsync(providerRaw);
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
    const provider = await getByokProviderAsync(providerRaw);
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

const transcribeSchema = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1).max(600),
  model: z.string().min(1).max(120),
  // dataURL (data:audio/...;base64,...) — JSON avoids a multipart dep;
  // 40mb body limit applies. Capped to 25MB raw (Whisper API limit).
  audio: z.string().min(1),
});

// POST /api/byok/transcribe — speech-to-text through the user's own provider
// key (OpenAI-compatible /audio/transcriptions: OpenAI, Groq, custom
// endpoints). The key + audio are used for this single call only and never
// stored. Browser hits our API (no CORS surprises); we relay multipart.
router.post(
  "/transcribe",
  requireAuth,
  validateBody(transcribeSchema),
  async (req, res) => {
    const { provider: providerRaw, apiKey, model, audio } = req.body as z.infer<
      typeof transcribeSchema
    >;
    const provider = await getByokProviderAsync(providerRaw);
    if (!provider) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_PROVIDER", message: "Unknown provider." },
      });
    }
    if (provider.kind !== "openai") {
      return res.json({
        success: true,
        data: {
          text: "",
          message: `${provider.name} does not expose an OpenAI-compatible transcription endpoint — using the on-device default instead.`,
        },
      });
    }
    const trimmedKey = apiKey.trim();
    if (!isByokKeyFormatSupported(provider, trimmedKey)) {
      return res.json({
        success: true,
        data: {
          text: "",
          message: `This doesn't look like a ${provider.name} key (expected ${provider.keyHint}).`,
        },
      });
    }

    const dataUrl = audio.trim();
    const dataMatch = /^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
    if (!dataMatch) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_AUDIO", message: "Audio must be a base64 dataURL." },
      });
    }
    const [, mime, b64] = dataMatch;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_AUDIO", message: "Audio is not valid base64." },
      });
    }
    if (buf.length === 0 || buf.length > 25 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_AUDIO", message: "Audio must be 1 byte – 25MB." },
      });
    }
    const ext = (mime.split("/")[1] || "mp3").replace(/[^a-z0-9]/gi, "") || "mp3";

    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
      form.append("model", model.trim());
      form.append("response_format", "json");
      const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${trimmedKey}` },
        body: form,
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        return res.json({
          success: true,
          data: {
            text: "",
            message: `${provider.name} transcription failed (${response.status})${detail ? `: ${detail}` : ""} — using the on-device default instead.`,
          },
        });
      }
      const json = (await response.json()) as any;
      const text = typeof json?.text === "string" ? json.text.trim() : "";
      return res.json({ success: true, data: { text } });
    } catch (err: any) {
      return res.json({
        success: true,
        data: {
          text: "",
          message: `Could not reach ${provider.name} for transcription — using the on-device default instead.`,
        },
      });
    }
  }
);

export default router;
