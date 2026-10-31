// schemas/exams.ts
// Zod contracts and DTOs for exams and their rounds (job profile -> exams ->
// rounds). Datetimes are ISO strings with an offset (UTC on the wire).
// Why: the round settings are the former per-role exam settings, moved here so
// every round carries its own duration, window and instructions.

import { z } from 'zod';

const examName = z.string().trim().min(1).max(150);
const instant = z.string().datetime({ offset: true }).nullable().optional();

export const ExamCreateSchema = z.object({
  jobRoleId: z.string().uuid(),
  name: examName,
});
export type ExamCreateInput = z.infer<typeof ExamCreateSchema>;

export const ExamUpdateSchema = z
  .object({
    name: examName.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type ExamUpdateInput = z.infer<typeof ExamUpdateSchema>;

// The round number is assigned by the server (max + 1 within the exam).
export const RoundCreateSchema = z.object({ name: z.string().trim().max(100).optional() });
export type RoundCreateInput = z.infer<typeof RoundCreateSchema>;

export const RoundSettingsSchema = z
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
export type RoundSettingsInput = z.infer<typeof RoundSettingsSchema>;

export interface RoundDto {
  id: string;
  examId: string;
  roundNumber: number;
  name: string;
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
  questionsLocked: boolean;
  counts: { questions: number; entries: number };
}

export interface ExamDto {
  id: string;
  jobRoleId: string;
  jobRoleName: string;
  name: string;
  active: boolean;
  rounds: RoundDto[];
}
