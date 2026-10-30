// modules/adminUsers/adminUsers.controller.ts
// Thin HTTP layer; the acting Super Admin comes from req.admin.

import type { NextFunction, Request, Response } from 'express';
import { ok } from '../../shared/http.js';
import { unauthorized } from '../../shared/errors.js';
import type { AdminUsersService } from './adminUsers.service.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const actorId = (req: Request): string => {
  if (!req.admin) throw unauthorized();
  return req.admin.id;
};

export function createAdminUsersController(service: AdminUsersService) {
  return {
    list: wrap(async (req, res) => ok(res, await service.list((req.query as unknown as { page: number }).page))),
    create: wrap(async (req, res) => ok(res, await service.create(req.body, actorId(req), req.ip ?? null), 201)),
    update: wrap(async (req, res) =>
      ok(res, await service.update((req.params as { id: string }).id, req.body, actorId(req), req.ip ?? null)),
    ),
  };
}
