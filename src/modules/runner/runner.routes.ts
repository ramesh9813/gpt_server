import { Router } from "express";
import { z } from "zod";
import { env } from "../../lib/config";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody } from "../../middleware/validate";

const router = Router();

const runSchema = z.object({
  language: z.string().min(1).max(32),
  code: z.string().min(1).max(20000)
});

type Runtime = {
  language: string;
  version: string;
  aliases?: string[];
};

const runtimeCache: { data: Runtime[] | null; fetchedAt: number } = {
  data: null,
  fetchedAt: 0
};

const CACHE_TTL_MS = 5 * 60 * 1000;

const getRuntimes = async () => {
  const now = Date.now();
  if (runtimeCache.data && now - runtimeCache.fetchedAt < CACHE_TTL_MS) {
    return runtimeCache.data;
  }

  const response = await fetch(`${env.RUNNER_BASE_URL}/runtimes`);
  if (!response.ok) {
    throw new Error("Failed to fetch runtimes");
  }
  const data = (await response.json()) as Runtime[];
  runtimeCache.data = data;
  runtimeCache.fetchedAt = now;
  return data;
};

const resolveRuntime = async (language: string) => {
  const runtimes = await getRuntimes();
  const target = language.toLowerCase();
  const match = runtimes.find((runtime) => {
    if (runtime.language.toLowerCase() === target) return true;
    return runtime.aliases?.some((alias) => alias.toLowerCase() === target);
  });
  return match || null;
};

const languageFileName = (language: string) => {
  switch (language) {
    case "python":
      return "main.py";
    case "c":
      return "main.c";
    case "cpp":
      return "main.cpp";
    case "rust":
      return "main.rs";
    case "java":
      return "Main.java";
    default:
      return "main.txt";
  }
};

router.post("/execute", requireAuth, validateBody(runSchema), async (req, res) => {
  const language = req.body.language.toLowerCase();
  const code = req.body.code;

  try {
    const runtime = await resolveRuntime(language);
    if (!runtime) {
      return res.status(400).json({
        success: false,
        error: {
          code: "UNSUPPORTED_LANGUAGE",
          message: `Language not supported: ${language}`
        }
      });
    }

    const controller = new AbortController();
    const timeoutMs = Number(env.RUNNER_TIMEOUT_MS) || 10000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${env.RUNNER_BASE_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: runtime.language,
        version: runtime.version,
        files: [
          {
            name: languageFileName(runtime.language.toLowerCase()),
            content: code
          }
        ]
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        error: {
          code: "RUNNER_ERROR",
          message: payload?.message || "Runner request failed"
        }
      });
    }

    const run = payload?.run || payload || {};

    return res.json({
      success: true,
      data: {
        stdout: run.stdout || "",
        stderr: run.stderr || "",
        output: run.output || "",
        code: run.code ?? null,
        signal: run.signal ?? null,
        language: runtime.language,
        version: runtime.version
      }
    });
  } catch (err: any) {
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
