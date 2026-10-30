// schemas/roles.ts
// Zod contracts for job roles and their exam settings, shared by the API and
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

const instant = z.string().datetime({ offset: true }).nullable().optional();

export const ExamSettingsUpdateSchema = z
  .object({
    durationMinutes: z.number().int().min(10).max(240),
    windowStart: instant,
    windowEnd: instant,
    instructions: z.string().max(10_000),
    isOpen: z.boolean(),
  })
  .refine(
    (v) => !v.windowStart || !v.windowEnd || new Date(v.windowEnd).getTime() > new Date(v.windowStart).getTime(),
    { message: 'Window end must be after window start', path: ['windowEnd'] },
  );
export type ExamSettingsUpdateInput = z.infer<typeof ExamSettingsUpdateSchema>;

export interface ExamSettingDto {
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
  questionsLocked: boolean;
}

export interface JobRoleDto {
  id: string;
  name: string;
  refApplicantCount: number;
  active: boolean;
  settings: ExamSettingDto;
  counts: { questions: number; candidates: number };
}
