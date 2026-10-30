// modules/integrations/integrations.routes.ts
// Super Admin only: router.ts mounts this behind authenticateAdmin +
// authorize('SUPER_ADMIN'); the factory takes the service with audit wired.

import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.js';
import { createIntegrationsController } from './integrations.controller.js';
import type { IntegrationsService } from './integrations.service.js';
import {
  EmailConfigInputSchema,
  EmailTestInputSchema,
  SmsConfigInputSchema,
  SmsTestInputSchema,
} from './integrations.schemas.js';

export function createIntegrationsRouter(service: IntegrationsService): Router {
  const c = createIntegrationsController(service);
  const r = Router();
  r.get('/', c.get);
  r.put('/sms', validate({ body: SmsConfigInputSchema }), c.updateSms);
  r.put('/email', validate({ body: EmailConfigInputSchema }), c.updateEmail);
  r.post('/sms/test', validate({ body: SmsTestInputSchema }), c.testSms);
  r.post('/email/test', validate({ body: EmailTestInputSchema }), c.testEmail);
  return r;
}
