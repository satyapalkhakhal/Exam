// modules/exam/exam.routes.ts
// /api/candidate/exams: the candidate's exam list, and per application
// (/:applicationId) detail, start, state, resume, autosave, events and submit.
// All run as the signed-in account; resolveApplication 404s an application that
// is not the account's own or not eligible. The answer beacon and the events endpoint are
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
import { resolveApplication } from '../../shared/middleware/resolveApplication.js';
import { validate } from '../../shared/middleware/validate.js';
import { createExamController } from './exam.controller.js';
import { ApplicationParamsSchema, ApplicationQuestionParamsSchema, ExamEventsSchema, ExamStartSchema, SaveAnswerSchema, SubmitExamSchema } from './exam.schemas.js';
import { SaveChoiceSchema } from '@exam/shared';
import type { ExamService } from './exam.service.js';

const BODY_LIMIT = '256kb';

export function createExamRouter(service: ExamService, auth: BeaconAuthDeps, owns: (accountId: string, applicationId: string) => Promise<boolean>): Router {
  const c = createExamController(service);
  const strict = authenticateCandidate(auth.isActive);
  const unload = authenticateCandidateBeacon(auth);
  const appParams = validate({ params: ApplicationParamsSchema });
  const ownApp = resolveApplication(owns);
  const answerParams = validate({ params: ApplicationQuestionParamsSchema });
  const r = Router();
  r.get('/', strict, c.list);
  r.get('/:applicationId', strict, appParams, ownApp, c.detail);
  r.post('/:applicationId/start', strict, appParams, ownApp, validate({ body: ExamStartSchema }), c.start);
  r.get('/:applicationId/state', strict, appParams, ownApp, c.state);
  r.get('/:applicationId/summary', strict, appParams, ownApp, c.summary);
  r.post('/:applicationId/resume', strict, appParams, ownApp, c.resume);
  r.put(
    '/:applicationId/answers/:attemptQuestionId',
    strict,
    appParams,
    ownApp,
    candidateExamWriteLimiter,
    answerParams,
    validate({ body: SaveAnswerSchema }),
    c.save,
  );
  // An MCQ choice (spec 2026-11-10 MCQ questions): same guards and limits as the answer save.
  r.put(
    '/:applicationId/answers/:attemptQuestionId/choice',
    strict,
    appParams,
    ownApp,
    candidateExamWriteLimiter,
    answerParams,
    validate({ body: SaveChoiceSchema }),
    c.choice,
  );
  r.post(
    '/:applicationId/answers/:attemptQuestionId/beacon',
    sameOriginOnly,
    express.text({ type: 'text/plain', limit: BODY_LIMIT }),
    unload,
    appParams,
    ownApp,
    candidateExamWriteLimiter,
    answerParams,
    c.beacon,
  );
  r.post('/:applicationId/events', sameOriginOnly, unload, appParams, ownApp, candidateExamWriteLimiter, validate({ body: ExamEventsSchema }), c.events);
  r.post('/:applicationId/submit', strict, appParams, ownApp, validate({ body: SubmitExamSchema }), c.submit);
  return r;
}
