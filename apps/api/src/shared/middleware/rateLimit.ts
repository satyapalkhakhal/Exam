// shared/middleware/rateLimit.ts
// Redis-backed rate limits (shared across API instances), keys under
// `exam:rl:<name>:`. Each limiter is built on first use, not at import, so
// loading the app never opens a Redis connection by itself. Over-limit
// requests get the standard RATE_LIMITED envelope.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getRedis } from '../../infrastructure/redis/redis.js';
import { tooMany } from '../errors.js';

function lazyLimiter(opts: {
  name: string;
  windowMs: number;
  limit: number;
  key: (req: Request) => string;
  skip?: (req: Request) => boolean;
}): RequestHandler {
  let limiter: RequestHandler | undefined;
  return (req: Request, res: Response, next: NextFunction) => {
    limiter ??= rateLimit({
      windowMs: opts.windowMs,
      limit: opts.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: opts.key,
      ...(opts.skip ? { skip: opts.skip } : {}),
      // Built on first request on purpose (see header); counts live in Redis,
      // so the "created in a request handler" warning does not apply.
      validate: { creationStack: false },
      handler: (_req, _res, nxt) => nxt(tooMany('Too many attempts. Please try again later.')),
      store: new RedisStore({
        prefix: `exam:rl:${opts.name}:`,
        sendCommand: (command: string, ...args: string[]) => getRedis().call(command, ...args) as Promise<RedisReply>,
      }),
    });
    void limiter(req, res, next);
  };
}

const ipOf = (req: Request): string => req.ip ?? 'unknown';
const bodyEmail = (req: Request): string => {
  const e: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' ? e.trim().toLowerCase().slice(0, 254) : '';
};

/** Admin OTP step: 10 per 10 min per IP (the code itself also allows only 5 tries). */
export const adminOtpVerifyLimiter = lazyLimiter({
  name: 'adminOtpVerify',
  windowMs: 10 * 60_000,
  limit: 10,
  key: ipOf,
});

/** Admin password step: 10 per 15 min per IP + email. */
export const adminLoginLimiter = lazyLimiter({
  name: 'adminLogin',
  windowMs: 15 * 60_000,
  limit: 10,
  key: (req) => `${ipOf(req)}|${bodyEmail(req)}`,
});

// Mirrors the service's identifier handling (trim, lower-case, a +91/91 prefix
// on a mobile). Returns null for anything that is not a plausible email or
// 10-digit mobile: those requests skip the per-identifier limiter (validation
// answers 400) so junk bodies can never share one bucket and lock everyone out.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalisedIdentifier = (req: Request): string | null => {
  const v: unknown = (req.body as { identifier?: unknown } | undefined)?.identifier;
  if (typeof v !== 'string') return null;
  const id = v.trim().toLowerCase();
  if (id.length > 254) return null;
  const mobile = id.replace(/^\+?91(?=\d{10}$)/, '');
  if (/^\d{10}$/.test(mobile)) return mobile;
  return EMAIL_SHAPE.test(id) ? id : null;
};
const skipJunkIdentifier = (req: Request): boolean => normalisedIdentifier(req) === null;
const bodyIdentifier = (req: Request): string => normalisedIdentifier(req) ?? '';

/** Candidate OTP request: 5 per 10 min per identifier. */
export const candidateOtpIdentifierLimiter = lazyLimiter({
  name: 'candOtpId',
  windowMs: 10 * 60_000,
  limit: 5,
  key: (req) => bodyIdentifier(req),
  skip: skipJunkIdentifier,
});

/**
 * Per-IP ceiling for candidate request-otp and verify-otp, per 10 min. A whole
 * cohort (461, plus resends) can sit behind one campus or hostel NAT at the
 * exam start, so this stays well above it; brute force is bounded by the
 * per-identifier limits and the 5-try cap on each code.
 */
export const CANDIDATE_OTP_IP_LIMIT = 1000;

/** Candidate OTP request: CANDIDATE_OTP_IP_LIMIT per 10 min per IP. */
export const candidateOtpIpLimiter = lazyLimiter({
  name: 'candOtpIp',
  windowMs: 10 * 60_000,
  limit: CANDIDATE_OTP_IP_LIMIT,
  key: (req) => ipOf(req),
});

/** Candidate OTP verify: CANDIDATE_OTP_IP_LIMIT per 10 min per IP. */
export const candidateVerifyLimiter = lazyLimiter({
  name: 'candVerify',
  windowMs: 10 * 60_000,
  limit: CANDIDATE_OTP_IP_LIMIT,
  key: (req) => ipOf(req),
});

/** Candidate OTP verify: 10 per 10 min per identifier. */
export const candidateVerifyIdentifierLimiter = lazyLimiter({
  name: 'candVerifyId',
  windowMs: 10 * 60_000,
  limit: 10,
  key: (req) => bodyIdentifier(req),
  skip: skipJunkIdentifier,
});

/** Location capture: 30 per 10 min per signed-in candidate (mount after authenticateCandidate). */
export const candidateLocationLimiter = lazyLimiter({
  name: 'candLocation',
  windowMs: 10 * 60_000,
  limit: 30,
  key: (req) => req.candidate?.id ?? ipOf(req),
});

/** Admin spreadsheet uploads: 20 per 10 min per signed-in admin (mount after authenticateAdmin). */
export const adminUploadLimiter = lazyLimiter({
  name: 'adminUpload',
  windowMs: 10 * 60_000,
  limit: 20,
  key: (req) => req.admin?.id ?? ipOf(req),
});

/** Exam saves, beacons and event batches: 1200 per 10 min per candidate (autosave runs every few seconds). */
export const candidateExamWriteLimiter = lazyLimiter({
  name: 'candExamWrite',
  windowMs: 10 * 60_000,
  limit: 1200,
  key: (req) => req.candidate?.id ?? ipOf(req),
});
