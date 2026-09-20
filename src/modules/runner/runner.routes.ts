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

type WandboxCompiler = {
  name: string;
  language: string;
  version?: string;
};

type ExecuteResult = {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: string | null;
  language: string;
  version: string;
};

class RunnerError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const pistonCache: { data: Runtime[] | null; fetchedAt: number } = {
  data: null,
  fetchedAt: 0
};

const wandboxCache: { data: WandboxCompiler[] | null; fetchedAt: number } = {
  data: null,
  fetchedAt: 0
};

const getRuntimes = async () => {
  const now = Date.now();
  if (pistonCache.data && now - pistonCache.fetchedAt < CACHE_TTL_MS) {
    return pistonCache.data;
  }

  const response = await fetch(`${env.RUNNER_BASE_URL}/runtimes`);
  if (!response.ok) {
    throw new Error("Failed to fetch runtimes");
  }
  const data = (await response.json()) as Runtime[];
  pistonCache.data = data;
  pistonCache.fetchedAt = now;
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

const executeWithPiston = async (
  language: string,
  code: string
): Promise<ExecuteResult> => {
  const runtime = await resolveRuntime(language);
  if (!runtime) {
    throw new RunnerError(
      400,
      "UNSUPPORTED_LANGUAGE",
      `Language not supported: ${language}`
    );
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
    throw new RunnerError(
      500,
      "RUNNER_ERROR",
      payload?.message || "Runner request failed"
    );
  }

  const run = payload?.run || payload || {};

  return {
    stdout: run.stdout || "",
    stderr: run.stderr || "",
    output: run.output || "",
    code: run.code ?? null,
    signal: run.signal ?? null,
    language: runtime.language,
    version: runtime.version
  };
};

// ---------- Wandbox (default) ----------
// Free public API, no key required: POST {base}/api/compile.json
// { compiler, code }. The public Piston instance is whitelist-only since
// 2/15/2026, so Wandbox is the default provider. Set RUNNER_PROVIDER=piston
// with RUNNER_BASE_URL pointing at your own Piston instance to switch back.

const WANDBOX_LANGUAGE_ALIASES: Record<string, string> = {
  python: "Python",
  py: "Python",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  rust: "Rust",
  rs: "Rust",
  java: "Java"
};

const getWandboxCompilers = async (): Promise<WandboxCompiler[]> => {
  const now = Date.now();
  if (wandboxCache.data && now - wandboxCache.fetchedAt < CACHE_TTL_MS) {
    return wandboxCache.data;
  }

  const response = await fetch(
    `${env.WANDBOX_BASE_URL}/api/list.json`
  );
  if (!response.ok) {
    throw new Error("Failed to fetch Wandbox compilers");
  }
  const data = (await response.json()) as WandboxCompiler[];
  wandboxCache.data = data;
  wandboxCache.fetchedAt = now;
  return data;
};

const resolveWandboxCompiler = (
  compilers: WandboxCompiler[],
  language: string
): WandboxCompiler | null => {
  const label = WANDBOX_LANGUAGE_ALIASES[language.toLowerCase()];
  if (!label) return null;
  const matches = compilers.filter((c) => c.language === label);
  if (matches.length === 0) return null;
  // Prefer a pinned release over a rolling "head" build for stability.
  return matches.find((c) => !c.name.includes("head")) || matches[0];
};

// Wandbox compiles a single prog.java, so `public class Main` (the Piston-era
// filename convention) would fail. Demote it to a package-private class.
const adaptJavaForWandbox = (code: string): string =>
  code.replace(/public\s+class\s+Main\b/, "class Main");

type WandboxResult = {
  status?: string;
  compiler_output?: string;
  compiler_error?: string;
  program_output?: string;
  program_error?: string;
  signal?: string;
};

const executeWithWandbox = async (
  language: string,
  code: string
): Promise<ExecuteResult> => {
  const compilers = await getWandboxCompilers();
  const compiler = resolveWandboxCompiler(compilers, language);
  if (!compiler) {
    throw new RunnerError(
      400,
      "UNSUPPORTED_LANGUAGE",
      `Language not supported: ${language}`
    );
  }

  const controller = new AbortController();
  // Cold compiles (esp. C++/Rust) can take a while on the shared instance.
  const timeoutMs = Number(env.RUNNER_TIMEOUT_MS) || 30000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const source =
    language.toLowerCase() === "java" ? adaptJavaForWandbox(code) : code;

  const response = await fetch(`${env.WANDBOX_BASE_URL}/api/compile.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ compiler: compiler.name, code: source }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const payload = (await response.json().catch(
    () => ({})
  )) as WandboxResult;

  if (!response.ok) {
    throw new RunnerError(
      500,
      "RUNNER_ERROR",
      "Wandbox request failed"
    );
  }

  const exitCode =
    payload.status !== undefined && /^-?\d+$/.test(payload.status)
      ? Number(payload.status)
      : null;
  const compileDiagnostics = [payload.compiler_output, payload.compiler_error]
    .filter((s) => s && s.length > 0)
    .join("\n");
  const stdout = payload.program_output || "";
  const stderr = [compileDiagnostics, payload.program_error]
    .filter((s) => s && s.length > 0)
    .join("\n");

  return {
    stdout,
    stderr,
    output: stdout || stderr,
    code: exitCode,
    signal: payload.signal || null,
    language: compiler.language,
    version: compiler.version || compiler.name
  };
};

router.post("/execute", requireAuth, validateBody(runSchema), async (req, res) => {
  const language = req.body.language.toLowerCase();
  const code = req.body.code;

  try {
    const data =
      env.RUNNER_PROVIDER === "wandbox"
        ? await executeWithWandbox(language, code)
        : await executeWithPiston(language, code);

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
