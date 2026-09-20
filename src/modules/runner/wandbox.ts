// Wandbox code-execution provider (default). Split from runner.routes.ts. No logic changes.
import { env } from "../../lib/config";
import { CACHE_TTL_MS, RunnerError, type ExecuteResult, type WandboxCompiler } from "./types";

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

export const executeWithWandbox = async (
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

