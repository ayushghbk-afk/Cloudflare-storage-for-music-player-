/**
 * Typed application errors.
 *
 * Every failure that leaves the API is an `AppError` mapped to a stable JSON
 * envelope:
 *   { "error": { "code": "...", "message": "...", "details": ..., "requestId": "..." } }
 *
 * Unexpected errors are mapped to a generic 500 and logged with the request id;
 * their internals are never returned to clients.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** Whether the message is safe to show to the caller. */
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, options?: { details?: unknown; expose?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options?.details;
    this.expose = options?.expose ?? true;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'BAD_REQUEST', message, { details });

export const validationFailed = (message: string, details?: unknown): AppError =>
  new AppError(422, 'VALIDATION_FAILED', message, { details });

export const unauthorized = (message = 'Authentication required.'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to perform this action.'): AppError =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found.'): AppError => new AppError(404, 'NOT_FOUND', message);

export const methodNotAllowed = (message = 'Method not allowed.'): AppError =>
  new AppError(405, 'METHOD_NOT_ALLOWED', message);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'CONFLICT', message, { details });

export const payloadTooLarge = (message: string): AppError => new AppError(413, 'PAYLOAD_TOO_LARGE', message);

export const rangeNotSatisfiable = (message = 'Requested range not satisfiable.'): AppError =>
  new AppError(416, 'RANGE_NOT_SATISFIABLE', message);

export const tooManyRequests = (message: string, retryAfterSeconds: number): AppError =>
  new AppError(429, 'RATE_LIMITED', message, { details: { retryAfterSeconds } });

export const internal = (message = 'Internal error.', cause?: unknown): AppError =>
  new AppError(500, 'INTERNAL_ERROR', message, { expose: false, cause });

export const notConfigured = (message: string, details?: unknown): AppError =>
  new AppError(503, 'NOT_CONFIGURED', message, { details });

export const unavailable = (message: string, details?: unknown): AppError =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message, { details });

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;
