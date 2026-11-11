// modules/jobRoles/index.ts
// Barrel: job roles (job profiles) on the Prisma repository.

import { drivesRepository } from '../drives/index.js';
import { jobRolesRepository } from './jobRoles.repository.js';
import { createJobRolesService } from './jobRoles.service.js';

export { createJobRolesRouter } from './jobRoles.routes.js';
export { createJobRolesService } from './jobRoles.service.js';
export type { JobRolesService, JobRolesRepository, JobRoleRow } from './jobRoles.service.js';
export { jobRolesRepository };

export const jobRoles = createJobRolesService(jobRolesRepository, { listDrives: () => drivesRepository.listDrives({}) });
