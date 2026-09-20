// Piston code-execution provider. Split from runner.routes.ts. No logic changes.
import { env } from "../../lib/config";
import { CACHE_TTL_MS, RunnerError, type ExecuteResult, type Runtime } from "./types";

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

export const executeWithPiston = async (
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

