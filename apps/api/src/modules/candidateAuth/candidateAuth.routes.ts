// modules/candidateAuth/candidateAuth.routes.ts
// /api/candidate: the public auth endpoints (rate limited per IP and
// identifier; refresh and logout work from the refresh cookie alone), then the
// session-protected reads and the location capture.

import { Router } from 'express';
import {
  CandidateRequestOtpSchema,
  CandidateVerifyOtpSchema,
  LocationPayloadSchema,
} from '@exam/shared';
import { authenticateCandidate } from '../../shared/middleware/authenticateCandidate.js';
import {
  candidateOtpIdentifierLimiter,
  candidateLocationLimiter,
  candidateOtpIpLimiter,
  candidateVerifyIdentifierLimiter,
  candidateVerifyLimiter,
} from '../../shared/middleware/rateLimit.js';
import { validate } from '../../shared/middleware/validate.js';
import { createCandidateAuthController } from './candidateAuth.controller.js';
import type { CandidateAuthService } from './candidateAuth.service.js';

export function createCandidateAuthRouter(service: CandidateAuthService): Router {
  const c = createCandidateAuthController(service);
  const auth = authenticateCandidate(service.isActive);
  const r = Router();
  r.post(
    '/auth/request-otp',
    candidateOtpIpLimiter,
    candidateOtpIdentifierLimiter,
    validate({ body: CandidateRequestOtpSchema }),
    c.requestOtp,
  );
  r.post('/auth/verify-otp', candidateVerifyLimiter, candidateVerifyIdentifierLimiter, validate({ body: CandidateVerifyOtpSchema }), c.verifyOtp);
  r.post('/auth/refresh', c.refresh);
  r.post('/auth/logout', c.logout);
  r.get('/me', auth, c.me);
  r.post('/location', auth, candidateLocationLimiter, validate({ body: LocationPayloadSchema }), c.location);
  r.get('/exam/info', auth, c.examInfo);
  return r;
}
