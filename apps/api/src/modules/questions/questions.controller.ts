// modules/questions/questions.controller.ts
// Thin HTTP layer; the acting admin comes from req.admin. The template is a
// header-only CSV so nothing in it can be imported by accident.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { badRequest, unauthorized } from '../../shared/errors.js';
import type { QuestionsService } from './questions.service.js';
import { SAMPLE_CSV, TEMPLATE_COLUMNS } from './questionImport.parser.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
};

const actorId = (req: Request): string => {
  if (!req.admin) throw unauthorized();
  return req.admin.id;
};
const idOf = (req: Request): string => (req.params as { id: string }).id;
const ipOf = (req: Request): string | null => req.ip ?? null;

export function createQuestionsController(service: QuestionsService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.list(req.query as never))),
    create: wrap(async (req, res) => ok(res, await service.create(req.body, actorId(req), ipOf(req)), 201)),
    update: wrap(async (req, res) => ok(res, await service.update(idOf(req), req.body, actorId(req), ipOf(req)))),
    setActive: wrap(async (req, res) =>
      ok(res, await service.setActive(idOf(req), (req.body as { active: boolean }).active, actorId(req), ipOf(req))),
    ),
    reorder: wrap(async (req, res) =>
      ok(res, await service.reorder(idOf(req), (req.body as { ids: string[] }).ids, actorId(req), ipOf(req))),
    ),
    unlock: wrap(async (req, res) =>
      ok(res, await service.unlock(idOf(req), (req.body as { reason: string }).reason, actorId(req), ipOf(req))),
    ),
    preview: wrap(async (req, res) => {
      if (!req.file) throw badRequest('A file is required');
      const { jobRoleId } = req.body as { jobRoleId: string };
      return ok(res, await service.previewImport(req.file, jobRoleId, actorId(req)));
    }),
    confirm: wrap(async (req, res) => ok(res, await service.confirmImport(req.body, actorId(req), ipOf(req)))),
    template: wrap((_req, res) => {
      res
        .status(200)
        .type('text/csv')
        .set('Content-Disposition', 'attachment; filename="questions-template.csv"')
        .send(`${TEMPLATE_COLUMNS.join(',')}\n`);
    }),
    sample: wrap((_req, res) => {
      res
        .status(200)
        .type('text/csv')
        .set('Content-Disposition', 'attachment; filename="questions-sample.csv"')
        .send(SAMPLE_CSV);
    }),
  };
}
