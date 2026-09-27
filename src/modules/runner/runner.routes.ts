import { Router } from "express";
import { z } from "zod";
import { env } from "../../lib/config";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";
import { executeWithPiston } from "./piston";
import { executeWithWandbox } from "./wandbox";
import { RunnerError } from "./types";
import { SUPPORTED_RUN_LANGUAGES, RUNNER_OUTPUT_TRUNCATE_AT } from "../../lib/constants";

const router = Router();

const runSchema = z.object({
  language: z.enum(SUPPORTED_RUN_LANGUAGES),
  code: z.string().min(1).max(20000),
});

const truncateOutput = (s: string | undefined | null): string => {
  if (!s) return "";
  return s.length > RUNNER_OUTPUT_TRUNCATE_AT
    ? s.slice(0, RUNNER_OUTPUT_TRUNCATE_AT) + `\n…[truncated ${s.length - RUNNER_OUTPUT_TRUNCATE_AT} chars]`
    : s;
};

router.post("/execute", requireAuth, validateBody(runSchema), async (req, res) => {
  const language = req.body.language.toLowerCase();
  const code = req.body.code;

  try {
    const raw =
      env.RUNNER_PROVIDER === "wandbox"
        ? await executeWithWandbox(language, code)
        : await executeWithPiston(language, code);

    const data = {
      ...raw,
      stdout: truncateOutput(raw.stdout),
      stderr: truncateOutput(raw.stderr),
      output: truncateOutput(raw.output),
    };
    return res.json({ success: true, data });
  } catch (err: any) {
    if (err instanceof RunnerError) {
      return res.status(err.status).json({
        success: false,
        error: { code: err.code, message: err.message }
      });
    }
    if (err?.name === "AbortError") {
      return res.status(504).json({
        success: false,
        error: {
          code: "RUNNER_TIMEOUT",
          message: "Code execution timed out"
        }
      });
    }
    return res.status(500).json({
      success: false,
      error: {
        code: "RUNNER_ERROR",
        message: err?.message || "Runner request failed"
      }
    });
  }
});

export default router;
