// modules/emails/emails.routes.ts
// Super Admin only: router.ts mounts both routers behind authenticateAdmin +
// authorize('SUPER_ADMIN'), at /admin/email-templates and /admin/emails (not at
// /admin, which would gate the evaluator routes mounted after it).

import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { createEmailsController } from './emails.controller.js';
import type { EmailsService } from './emails.service.js';
import {
  EmailDispatchListQuerySchema,
  EmailPreviewSchema,
  EmailSendSchema,
  EmailTemplateKeyParamsSchema,
  EmailTemplateUpdateSchema,
} from './emails.schemas.js';

export function createEmailTemplatesRouter(service: EmailsService): Router {
  const c = createEmailsController(service);
  const params = EmailTemplateKeyParamsSchema;
  const r = Router();
  r.get('/', c.listTemplates);
  r.put('/:key', validate({ params, body: EmailTemplateUpdateSchema }), c.saveTemplate);
  r.post('/:key/reset', validate({ params }), c.resetTemplate);
  r.post('/:key/preview', validate({ params, body: EmailPreviewSchema }), c.preview);
  r.post('/:key/test', validate({ params, body: EmailPreviewSchema }), c.test);
  return r;
}

export function createEmailsRouter(service: EmailsService): Router {
  const c = createEmailsController(service);
  const r = Router();
  r.post('/send', validate({ body: EmailSendSchema }), c.send);
  r.get('/', validate({ query: EmailDispatchListQuerySchema }), c.list);
  return r;
}
