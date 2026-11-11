type ErrorCode = "unauthorized" | "forbidden" | "not_found" | "validation" | "conflict" | "rate_limited" | "unavailable" | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, validation: 422, conflict: 409, rate_limited: 429, unavailable: 503, internal: 500,
};

// Shown to users: never put message content or secrets in `message`.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const forbidden = (what = "You do not have permission to do that.") => new AppError("forbidden", what);
export const notFound = (what = "Not found.") => new AppError("not_found", what);
