// modules/aiEvaluation/aiEvaluation.controller.ts
// Thin HTTP layer. The acting admin comes from `req.admin`, set by authenticateAdmin.

import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../../shared/errors.js';
import { ok } from '../../shared/http.js';
import type { AiActor, AiEvaluationService } from './aiEvaluation.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const actorOf = (req: Request): AiActor => {
  if (!req.admin) throw unauthorized();
  return { id: req.admin.id, ip: req.ip ?? null };
};

export function createAiEvaluationController(service: AiEvaluationService) {
  return {
    start: wrap(async (req, res) => ok(res, await service.start(req.body, actorOf(req)))),
    list: wrap(async (req, res) => ok(res, { items: await service.list((req.query as { driveId?: string }).driveId) })),
    cancel: wrap(async (req, res) => ok(res, await service.cancel((req.params as { runId: string }).runId, actorOf(req)))),
  };
}
