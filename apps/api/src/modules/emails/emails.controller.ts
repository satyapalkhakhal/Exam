// modules/emails/emails.controller.ts
// Thin HTTP layer for the Super Admin email routes. The acting admin comes from
// `req.admin`, set by authenticateAdmin; without it the request is rejected.

import type { NextFunction, Request, Response } from 'express';
import type { EmailDispatchListQuery, EmailTemplateKey } from '@exam/shared';
import { unauthorized } from '../../shared/errors.js';
import { ok } from '../../shared/http.js';
import type { EmailsService } from './emails.service.js';

const adminId = (req: Request): string => {
  const id = req.admin?.id;
  if (!id) throw unauthorized();
  return id;
};
const keyOf = (req: Request): EmailTemplateKey => (req.params as { key: EmailTemplateKey }).key;

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function createEmailsController(service: EmailsService) {
  return {
    listTemplates: wrap(async (_req, res) => ok(res, await service.listTemplates())),
    saveTemplate: wrap(async (req, res) => ok(res, await service.saveTemplate(keyOf(req), req.body, adminId(req)))),
    resetTemplate: wrap(async (req, res) => ok(res, await service.resetTemplate(keyOf(req), adminId(req)))),
    preview: wrap(async (req, res) => ok(res, await service.renderPreview(keyOf(req), req.body))),
    test: wrap(async (req, res) => ok(res, await service.sendTest(keyOf(req), req.body, adminId(req)))),
    send: wrap(async (req, res) => ok(res, await service.send(req.body, adminId(req)))),
    list: wrap(async (req, res) => ok(res, await service.listDispatches(req.query as unknown as EmailDispatchListQuery))),
  };
}
