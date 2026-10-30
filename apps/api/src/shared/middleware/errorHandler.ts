// shared/middleware/errorHandler.ts
// The only place errors become responses. AppError keeps its status/code;
// a plain error carrying a 4xx status (body-parser: 400/413/415) keeps that
// status with a generic message and is not logged as a fault; anything else is
// logged server-side and returned as a generic 500, so stack traces and
// internals never reach the client.

import type { ErrorRequestHandler } from 'express';
import type { ErrorCode } from '@exam/shared';
import { logger } from '../../infrastructure/logger/logger.js';
import { AppError } from '../errors.js';

function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  const s = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500 ? s : null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }
  // Body-parser and similar middleware throw plain errors carrying a 4xx status;
  // those are client mistakes, not server faults.
  const status = clientErrorStatus(err);
  if (status !== null) {
    const mapped: Record<number, { code: ErrorCode; message: string }> = {
      400: { code: 'VALIDATION_ERROR', message: 'Invalid request' },
      413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' },
      415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
    };
    const { code, message } = mapped[status] ?? { code: 'BAD_REQUEST', message: 'Bad request' };
    res.status(status).json({ success: false, error: { message, code } });
    return;
  }
  logger.error('unhandled error', {
    requestId: req.id,
    method: req.method,
    path: req.path,
    message: err instanceof Error ? err.message : 'unknown',
    stack: err instanceof Error ? err.stack : undefined,
  });
  res
    .status(500)
    .json({ success: false, error: { message: 'Internal server error', code: 'INTERNAL_ERROR' } });
};
