import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { listOpenRouterModels } from "../../lib/openrouter";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    // Show the full OpenRouter catalog to every role. Access control stays
    // enforced at send time (resolveModelForRole in chat/stream returns
    // 403 MODEL_NOT_ALLOWED for disallowed models).
    const models = await listOpenRouterModels();

    return res.json({
      success: true,
      data: { models },
      meta: { role: req.user!.role, total: models.length }
    });
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
