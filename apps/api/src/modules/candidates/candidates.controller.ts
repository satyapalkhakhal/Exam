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
    detail: wrap(async (req, res) => ok(res, await service.detail(idOf(req), req.query as never))),
    create: wrap(async (req, res) => ok(res, await service.create(req.body, actorId(req), ipOf(req)), 201)),
    update: wrap(async (req, res) => ok(res, await service.update(idOf(req), req.body, actorId(req), ipOf(req)))),
    eligibility: wrap(async (req, res) =>
      ok(res, await service.setEligibility(idOf(req), (req.body as { eligible: boolean }).eligible, actorId(req), ipOf(req))),
    ),
    locationExempt: wrap(async (req, res) => {
      const { exempt, reason } = req.body as { exempt: boolean; reason: string };
      return ok(res, await service.setLocationExempt(idOf(req), exempt, reason, actorId(req), ipOf(req)));
    }),
    addRegistration: wrap(async (req, res) =>
      ok(res, await service.addRegistration(idOf(req), (req.body as { examId: string }).examId, actorId(req), ipOf(req)), 201),
    ),
    removeRegistration: wrap(async (req, res) => {
      const { registrationId } = req.params as { registrationId: string };
      return ok(res, await service.removeRegistration(idOf(req), registrationId, actorId(req), ipOf(req)));
    }),
    reset: wrap(async (req, res) => {
      const { entryId } = req.params as { entryId: string };
      return ok(res, await service.resetAttempt(idOf(req), entryId, (req.body as { reason: string }).reason, actorId(req), ipOf(req)));
    }),
    preview: wrap(async (req, res) => {
      if (!req.file) throw badRequest('A file is required');
      const { examId } = req.body as { examId: string };
      return ok(res, await service.previewImport(req.file, examId, actorId(req)));
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
