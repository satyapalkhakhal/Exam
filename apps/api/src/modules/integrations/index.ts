// modules/integrations/index.ts
export { createIntegrationsRouter } from './integrations.routes.js';
export { createIntegrationsService } from './integrations.service.js';
export type { IntegrationsService, IntegrationsDeps, AuditEntry } from './integrations.service.js';
export { integrationsRepository } from './integrations.repository.js';
