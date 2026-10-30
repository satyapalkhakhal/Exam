// shared/errors.ts
// AppError carries an HTTP status and a machine-readable ErrorCode; the central
// error handler turns it into the single response envelope.

import type { ErrorCode } from '@exam/shared';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code: ErrorCode = 'VALIDATION_ERROR', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Unauthorized', code: ErrorCode = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'Forbidden', code: ErrorCode = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code: ErrorCode = 'CONFLICT') =>
  new AppError(409, code, message);
export const tooMany = (message = 'Too many requests', code: ErrorCode = 'RATE_LIMITED') =>
  new AppError(429, code, message);
