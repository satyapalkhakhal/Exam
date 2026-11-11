// modules/candidates/candidates.controller.ts
// Thin HTTP layer; the acting admin comes from req.admin. The template is a
// header-only CSV so nothing in it can be imported by accident.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { badRequest, unauthorized } from '../../shared/errors.js';
import type { CandidatesService } from './candidates.service.js';
import { TEMPLATE_COLUMNS } from './candidateImport.parser.js';

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

export function createCandidatesController(service: CandidatesService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.list(req.query as never))),
    matchingIds: wrap(async (req, res) => ok(res, await service.matchingIds(req.query as never))),
    contact: wrap(async (req, res) => ok(res, await service.revealContact((req.params as { id: string }).id, actorId(req), ipOf(req)))),
    detail: wrap(async (req, res) => ok(res, await service.detail(idOf(req), req.query as never))),
    create: wrap(async (req, res) => ok(res, await service.create(req.body, actorId(req), ipOf(req)), 201)),
    update: wrap(async (req, res) => ok(res, await service.update(idOf(req), req.body, actorId(req), ipOf(req)))),
    moveToDrive: wrap(async (req, res) => ok(res, await service.moveToDrive(req.body, actorId(req), ipOf(req)))),
    eligibility: wrap(async (req, res) =>
      ok(res, await service.setEligibility(idOf(req), (req.body as { eligible: boolean }).eligible, actorId(req), ipOf(req))),
    ),
    locationExempt: wrap(async (req, res) => {
      const { exempt, reason } = req.body as { exempt: boolean; reason: string };
      return ok(res, await service.setLocationExempt(idOf(req), exempt, reason, actorId(req), ipOf(req)));
    }),
    reset: wrap(async (req, res) =>
      ok(res, await service.resetAttempt(idOf(req), (req.body as { reason: string }).reason, actorId(req), ipOf(req))),
    ),
    preview: wrap(async (req, res) => {
      if (!req.file) throw badRequest('A file is required');
      const { driveId, updateExisting } = req.body as { driveId: string; updateExisting: boolean };
      return ok(res, await service.previewImport(req.file, driveId, actorId(req), updateExisting));
    }),
    confirm: wrap(async (req, res) => ok(res, await service.confirmImport(req.body, actorId(req), ipOf(req)))),
    template: wrap((_req, res) => {
      res
        .status(200)
        .type('text/csv')
        .set('Content-Disposition', 'attachment; filename="candidates-template.csv"')
        .send(`${TEMPLATE_COLUMNS.join(',')}\n`);
    }),
  };
}
