// modules/evaluation/evaluation.controller.ts
// Thin HTTP layer. The viewer's role (from the verified token, never the
// request) decides how blind each payload is.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import type { Actor, EvaluationService } from './evaluation.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
};

const actorOf = (req: Request): Actor => {
  if (!req.admin) throw unauthorized();
  return { id: req.admin.id, role: req.admin.role, ip: req.ip ?? null };
};
const attemptIdOf = (req: Request): string => (req.params as { attemptId: string }).attemptId;

export function createEvaluationController(service: EvaluationService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.list(req.query as never, actorOf(req).role))),
    marking: wrap(async (req, res) => ok(res, await service.marking(attemptIdOf(req), actorOf(req).role))),
    lock: wrap(async (req, res) => ok(res, await service.lock(attemptIdOf(req), actorOf(req)))),
    unlock: wrap(async (req, res) => {
      await service.unlock(attemptIdOf(req), actorOf(req));
      res.status(204).end();
    }),
    save: wrap(async (req, res) => ok(res, await service.save(attemptIdOf(req), req.body, actorOf(req)))),
    reopen: wrap(async (req, res) =>
      ok(res, await service.reopen(attemptIdOf(req), (req.body as { reason: string }).reason, actorOf(req))),
    ),
  };
}
