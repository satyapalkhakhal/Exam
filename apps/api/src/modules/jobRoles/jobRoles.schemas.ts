// modules/jobRoles/jobRoles.schemas.ts
// Request schemas live in @exam/shared so the web forms validate identically.
import { z } from 'zod';
export { JobRoleCreateSchema, JobRoleUpdateSchema } from '@exam/shared';

export const JobRoleIdParamsSchema = z.object({ id: z.string().uuid() });
