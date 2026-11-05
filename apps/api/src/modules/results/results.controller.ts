// modules/results/results.controller.ts
// Thin HTTP layer. Exports load all their data first and only then start the
// stream, so a failure still gets the normal JSON error envelope.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import { exportFileName, writeWorkbook, type SheetSpec } from './exports.js';
import type { Actor, ResultsService } from './results.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
};

const actorOf = (req: Request): Actor => {
  if (!req.admin) throw unauthorized();
  return { id: req.admin.id, ip: req.ip ?? null };
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function stream(res: Response, kind: 'results' | 'activity', data: { roleName: string | null; sheets: SheetSpec[] }) {
  res.status(200);
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(kind, data.roleName, new Date())}"`);
  res.setHeader('Cache-Control', 'no-store');
  await writeWorkbook(res, data.sheets);
}

export function createResultsController(service: ResultsService) {
  return {
    decide: wrap(async (req, res) => ok(res, await service.decide((req.params as { id: string }).id, req.body, actorOf(req)))),
    decideMany: wrap(async (req, res) => ok(res, await service.decideMany(req.body, actorOf(req)))),
    leaderboard: wrap(async (req, res) => ok(res, await service.leaderboard((req.query as { jobRoleId: string }).jobRoleId))),
    dashboard: wrap(async (_req, res) => ok(res, await service.dashboard())),
    resultsExport: wrap(async (req, res) => stream(res, 'results', await service.resultsExport((req.query as { jobRoleId?: string }).jobRoleId))),
    activityExport: wrap(async (req, res) => stream(res, 'activity', await service.activityExport((req.query as { jobRoleId?: string }).jobRoleId))),
  };
}
