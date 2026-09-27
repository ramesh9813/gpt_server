/**
 * Single source of truth for server errors.
 * Keeps HTTP status + machine code together so handlers never drift.
 */

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ProviderStatusError = Error & {
  status?: number;
  body?: string;
  challenged?: boolean;
};
