// modules/exams/exams.schemas.ts
// Body schemas live in @exam/shared; params and the list query are API-only.
import { z } from 'zod';
export { ExamCreateSchema, ExamUpdateSchema, RoundCreateSchema, RoundSettingsSchema } from '@exam/shared';

export const ExamIdParamsSchema = z.object({ id: z.string().uuid() });
export const RoundIdParamsSchema = z.object({ roundId: z.string().uuid() });

export const ExamListQuerySchema = z.object({
  jobRoleId: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type ExamListQuery = z.infer<typeof ExamListQuerySchema>;
