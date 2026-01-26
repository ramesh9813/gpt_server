import { Router } from "express";
import { env } from "../../lib/config";
const router = Router();

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedModels: unknown[] = [];
let cachedAt = 0;

const getModelsFromOpenRouter = async (useAuth: boolean) => {
          const headers: Record<string, string> = {
            "HTTP-Referer": env.APP_ORIGIN,
            "X-Title": "ChatUI"
          };
      
          if (useAuth && env.OROUTER_API_KEY) {
            headers.Authorization = `Bearer ${env.OROUTER_API_KEY}`;
          }
  return fetch(`${env.OPENROUTER_BASE_URL}/models`, { headers });
};

router.get("/", async (_req, res) => {
  const now = Date.now();
  if (cachedModels.length > 0 && now - cachedAt < CACHE_TTL_MS) {
    return res.json({
      success: true,
      data: { models: cachedModels },
      meta: { cached: true }
    });
  }

  try {
    let response = await getModelsFromOpenRouter(true);
    if (response.status === 401 || response.status === 403) {
      response = await getModelsFromOpenRouter(false);
    }

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({
        success: false,
        error: {
          code: "OPENROUTER_ERROR",
          message: "Failed to fetch models",
          details: errorText
        }
      });
    }

    const payload = await response.json();
    const models = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.models)
      ? payload.data.models
      : [];
    cachedModels = models;
    cachedAt = now;

    return res.json({ success: true, data: { models } });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      error: {
        code: "OPENROUTER_ERROR",
        message: "Failed to fetch models",
        details: err?.message || "Unknown error"
      }
    });
  }
});

export default router;
