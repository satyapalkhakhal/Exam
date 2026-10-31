// schemas/roles.ts
// Zod contracts for job roles (job profiles), shared by the API and
// the web forms. Datetimes are ISO strings with an offset (UTC on the wire).

import { z } from 'zod';

const roleName = z.string().trim().min(1).max(120);
const refCount = z.number().int().min(0).max(100_000);

export const JobRoleCreateSchema = z.object({
  name: roleName,
  refApplicantCount: refCount.optional(),
});
export type JobRoleCreateInput = z.infer<typeof JobRoleCreateSchema>;

export const JobRoleUpdateSchema = z
  .object({
    name: roleName.optional(),
    refApplicantCount: refCount.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type JobRoleUpdateInput = z.infer<typeof JobRoleUpdateSchema>;

export interface JobRoleDto {
  id: string;
  name: string;
  refApplicantCount: number;
  active: boolean;
  counts: { exams: number };
}
