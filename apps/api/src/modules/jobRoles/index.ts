// modules/jobRoles/index.ts
// Barrel: job roles and exam settings on the Prisma repository. `jobRoles` is
// the internal surface other modules (exam engine) use.

import { jobRolesRepository } from './jobRoles.repository.js';
import { createJobRolesService } from './jobRoles.service.js';

export { createJobRolesRouter } from './jobRoles.routes.js';
export { createJobRolesService } from './jobRoles.service.js';
export type { JobRolesService, JobRolesRepository, ExamSettingRow, JobRoleRow } from './jobRoles.service.js';
export { jobRolesRepository };

export const jobRoles = createJobRolesService(jobRolesRepository);
