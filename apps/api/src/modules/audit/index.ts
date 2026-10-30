// modules/audit/index.ts
// Barrel: the process-wide audit service on the Prisma repository.

import { auditRepository } from './audit.repository.js';
export { writeAudit } from './audit.repository.js';
import { createAuditService } from './audit.service.js';

export { createAuditService, AUDIT_PAGE_SIZE } from './audit.service.js';
export type { AuditRecord, AuditRow, AuditService, AuditRepository } from './audit.service.js';
export { createAuditRouter } from './audit.routes.js';

export const audit = createAuditService(auditRepository);
