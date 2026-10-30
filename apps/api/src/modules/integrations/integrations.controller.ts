// modules/integrations/integrations.controller.ts
// Thin HTTP layer. The acting admin comes from `req.admin`, set by
// authenticateAdmin; without it the request is rejected.

import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../../shared/errors.js';
import { ok } from '../../shared/http.js';
import type { IntegrationsService } from './integrations.service.js';

type AdminRequest = Request & { admin?: { id: string } };

const adminId = (req: Request): string => {
  const id = (req as AdminRequest).admin?.id;
  if (!id) throw unauthorized();
  return id;
};

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function createIntegrationsController(service: IntegrationsService) {
  return {
    get: wrap(async (_req, res) => ok(res, await service.get())),
    updateSms: wrap(async (req, res) => ok(res, await service.updateSms(req.body, adminId(req)))),
    updateEmail: wrap(async (req, res) => ok(res, await service.updateEmail(req.body, adminId(req)))),
    testSms: wrap(async (req, res) => ok(res, await service.testSms(req.body.mobile, adminId(req)))),
    testEmail: wrap(async (req, res) => ok(res, await service.testEmail(req.body.email, adminId(req)))),
  };
}
