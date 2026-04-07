import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import {
  filterModelsForRole,
  listOpenRouterModels
} from "../../lib/openrouter";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const models = await listOpenRouterModels();
    const visibleModels = filterModelsForRole(models, req.user!.role);

    return res.json({
      success: true,
      data: { models: visibleModels },
      meta: { role: req.user!.role }
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
