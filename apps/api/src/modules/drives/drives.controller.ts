// modules/drives/drives.controller.ts
// Thin HTTP layer; the acting Super Admin comes from req.admin.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import type { Actor, DrivesService } from './drives.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const actor = (req: Request): Actor => {
  if (!req.admin) throw unauthorized();
  return { id: req.admin.id, ip: req.ip ?? null };
};
const idOf = (req: Request): string => (req.params as { id: string }).id;

export function createDrivesController(service: DrivesService) {
  return {
    listColleges: wrap(async (_req, res) => ok(res, await service.listColleges())),
    createCollege: wrap(async (req, res) => ok(res, await service.createCollege(req.body, actor(req)), 201)),
    updateCollege: wrap(async (req, res) => ok(res, await service.updateCollege(idOf(req), req.body, actor(req)))),
    addRound: wrap(async (req, res) => ok(res, await service.addRound(idOf(req), req.body, actor(req)), 201)),
    updateRound: wrap(async (req, res) => ok(res, await service.updateRound(idOf(req), req.body, actor(req)))),
    listDrives: wrap(async (req, res) => ok(res, await service.listDrives(req.query as never))),
    createDrive: wrap(async (req, res) => ok(res, await service.createDrive(idOf(req), req.body, actor(req)), 201)),
    updateDrive: wrap(async (req, res) => ok(res, await service.updateDrive(idOf(req), req.body, actor(req)))),
    promote: wrap(async (req, res) => ok(res, await service.promote(idOf(req), actor(req)))),
  };
}
