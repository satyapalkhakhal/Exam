// schemas/roles.ts
// Zod contracts for job roles (UI: job profiles) with their rounds, shared by the API and
// the web forms. Datetimes are ISO strings with an offset (UTC on the wire).

import { z } from 'zod';
import { JOB_PROFILE_TYPES, type JobProfileType, type RoundDto } from './drives.js';

const roleName = z.string().trim().min(1).max(120);
const refCount = z.number().int().min(0).max(100_000);

export const JobRoleCreateSchema = z.object({
  name: roleName,
  type: z.enum(JOB_PROFILE_TYPES).default('PLACEMENT'),
  refApplicantCount: refCount.optional(),
});
export type JobRoleCreateInput = z.infer<typeof JobRoleCreateSchema>;

export const JobRoleUpdateSchema = z
  .object({
    name: roleName.optional(),
    type: z.enum(JOB_PROFILE_TYPES).optional(),
    refApplicantCount: refCount.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type JobRoleUpdateInput = z.infer<typeof JobRoleUpdateSchema>;

export interface JobRoleDto {
  id: string;
  name: string;
  type: JobProfileType;
  refApplicantCount: number;
  active: boolean;
  /** Round 1 first. Evaluators get rounds without drives. */
  rounds: RoundDto[];
  counts: { candidates: number };
}
