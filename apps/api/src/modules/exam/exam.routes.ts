// modules/exam/exam.routes.ts
// /api/candidate/exam: start, state, resume, autosave, events and submit. All
// run as the signed-in candidate. The answer beacon and the events endpoint are
// what the page sends on pagehide, so they also accept the refresh cookie when
// the access cookie has expired (authenticateCandidateBeacon). The beacon gets
// its own text/plain parser (sendBeacon cannot send application/json) with the
// app's JSON size cap; every other route only takes JSON. Both unload routes
// refuse cross-site requests (sameOriginOnly) before reading any cookie.

import express, { Router } from 'express';
import { authenticateCandidate } from '../../shared/middleware/authenticateCandidate.js';
import { authenticateCandidateBeacon, type BeaconAuthDeps } from '../../shared/middleware/authenticateCandidateBeacon.js';
import { candidateExamWriteLimiter } from '../../shared/middleware/rateLimit.js';
import { sameOriginOnly } from '../../shared/middleware/sameOriginOnly.js';
import { validate } from '../../shared/middleware/validate.js';
import { createExamController } from './exam.controller.js';
import { AttemptQuestionParamsSchema, ExamEventsSchema, ExamStartSchema, SaveAnswerSchema, SubmitExamSchema } from './exam.schemas.js';
import type { ExamService } from './exam.service.js';

const BODY_LIMIT = '256kb';

export function createExamRouter(service: ExamService, auth: BeaconAuthDeps): Router {
  const c = createExamController(service);
  const strict = authenticateCandidate(auth.isActive);
  const unload = authenticateCandidateBeacon(auth);
  const params = validate({ params: AttemptQuestionParamsSchema });
  const r = Router();
  r.post('/start', strict, validate({ body: ExamStartSchema }), c.start);
  r.get('/', strict, c.state);
  r.get('/summary', strict, c.summary);
  r.post('/resume', strict, c.resume);
  r.put('/answers/:attemptQuestionId', strict, candidateExamWriteLimiter, params, validate({ body: SaveAnswerSchema }), c.save);
  r.post(
    '/answers/:attemptQuestionId/beacon',
    sameOriginOnly,
    express.text({ type: 'text/plain', limit: BODY_LIMIT }),
    unload,
    candidateExamWriteLimiter,
    params,
    c.beacon,
  );
  r.post('/events', sameOriginOnly, unload, candidateExamWriteLimiter, validate({ body: ExamEventsSchema }), c.events);
  r.post('/submit', strict, validate({ body: SubmitExamSchema }), c.submit);
  return r;
}
