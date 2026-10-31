// modules/exams/exams.controller.ts
// Thin HTTP layer; the acting Super Admin comes from req.admin.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import type { ExamsService } from './exams.service.js';
import type { ExamListQuery } from './exams.schemas.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const actorId = (req: Request): string => {
  if (!req.admin) throw unauthorized();
  return req.admin.id;
};
const idOf = (req: Request): string => (req.params as { id: string }).id;
const roundIdOf = (req: Request): string => (req.params as { roundId: string }).roundId;

export function createExamsController(service: ExamsService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.list(req.query as unknown as ExamListQuery))),
    create: wrap(async (req, res) => ok(res, await service.create(req.body, actorId(req), req.ip ?? null), 201)),
    update: wrap(async (req, res) => ok(res, await service.update(idOf(req), req.body, actorId(req), req.ip ?? null))),
    addRound: wrap(async (req, res) =>
      ok(res, await service.addRound(idOf(req), req.body, actorId(req), req.ip ?? null), 201),
    ),
    updateRoundSettings: wrap(async (req, res) =>
      ok(res, await service.updateRoundSettings(roundIdOf(req), req.body, actorId(req), req.ip ?? null)),
    ),
  };
}
