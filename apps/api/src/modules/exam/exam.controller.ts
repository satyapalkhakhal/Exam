// modules/exam/exam.controller.ts
// Thin HTTP layer for the candidate exam. The account id comes from
// req.candidate (the verified token) and the application id from req.applicationId
// (the URL param, already checked against the account), never from the body. The
// beacon variant receives a text/plain body (sendBeacon's default) holding the
// same JSON as the normal save; it is parsed and validated here so both paths
// run the identical service call.

import type { NextFunction, Request, Response } from 'express';
import { badRequest, unauthorized } from '../../shared/errors.js';
import { ok } from '../../shared/http.js';
import { clientInfo } from '../../shared/utils/clientInfo.js';
import { SaveAnswerSchema } from './exam.schemas.js';
import type { ExamService } from './exam.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const authed = (req: Request) => {
  if (!req.candidate) throw unauthorized();
  return req.candidate;
};

/** The application resolveApplication verified belongs to the signed-in account. */
const app = (req: Request): string => {
  if (!req.applicationId) throw unauthorized();
  return req.applicationId;
};

const param = (req: Request): string => String(req.params.attemptQuestionId);

function parseBeacon(body: unknown) {
  let value: unknown = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      throw badRequest('Invalid request');
    }
  }
  const parsed = SaveAnswerSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      'Validation failed',
      'VALIDATION_ERROR',
      parsed.error.issues.map((i) => ({ path: ['body', ...i.path].join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function createExamController(service: ExamService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.listExams(authed(req).id))),
    detail: wrap(async (req, res) => ok(res, await service.getExam(authed(req).id, app(req)))),
    start: wrap(async (req, res) => ok(res, await service.start(authed(req), app(req), req.body, clientInfo(req)))),
    state: wrap(async (req, res) => ok(res, await service.getState(authed(req), app(req)))),
    summary: wrap(async (req, res) => ok(res, await service.getSummary(app(req)))),
    resume: wrap(async (req, res) => ok(res, await service.resume(authed(req), app(req), clientInfo(req)))),
    save: wrap(async (req, res) => ok(res, await service.saveAnswer(authed(req), app(req), param(req), req.body, clientInfo(req)))),
    beacon: wrap(async (req, res) =>
      ok(res, await service.saveAnswer(authed(req), app(req), param(req), parseBeacon(req.body), clientInfo(req))),
    ),
    events: wrap(async (req, res) => ok(res, await service.recordEvents(app(req), req.body, clientInfo(req)))),
    submit: wrap(async (req, res) => ok(res, await service.submit(app(req), req.body.sessionId, clientInfo(req)))),
  };
}
