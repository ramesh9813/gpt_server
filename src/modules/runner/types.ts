// Shared runner types + error. Split from runner.routes.ts. No logic changes.
export type Runtime = {
  language: string;
  version: string;
  aliases?: string[];
};

export type WandboxCompiler = {
  name: string;
  language: string;
  version?: string;
};

export type ExecuteResult = {
  stdout: string;
  stderr: string;
  output: string;
  code: number | null;
  signal: string | null;
  language: string;
  version: string;
};

export const CACHE_TTL_MS = 5 * 60 * 1000;

export class RunnerError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
