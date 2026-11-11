// schemas/drives.ts
// Colleges, rounds and campus drives (docs/superpowers/specs/2026-11-10-colleges-
// drives-rounds-design.md). job profile (Placement/Internship) -> rounds (the
// question bank, duration and weights shared by every college) -> drives (one
// round at one college in one batch: window, open switch, instructions).
// Candidates (applications) belong to a drive. Colleges and drives are Super
// Admin data: evaluators never receive them (blind marking).

import { z } from 'zod';
import { CompositeWeightsSchema, type CompositeWeights } from './aiEvaluation.js';

const uuid = z.string().uuid();

export const JOB_PROFILE_TYPES = ['PLACEMENT', 'INTERNSHIP'] as const;
export type JobProfileType = (typeof JOB_PROFILE_TYPES)[number];
export const JOB_PROFILE_TYPE_LABELS: Record<JobProfileType, string> = { PLACEMENT: 'Placement', INTERNSHIP: 'Internship' };

// ---- Colleges -------------------------------------------------------------------

const collegeName = z.string().trim().min(1).max(120);
/** 2–12 of A–Z, 0–9 or "-", stored upper-case (e.g. IITG, NIT-T). */
const shortCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2–12 letters, digits or "-"'));

export const CollegeCreateSchema = z.object({ name: collegeName, shortCode });
export type CollegeCreateInput = z.infer<typeof CollegeCreateSchema>;

export const CollegeUpdateSchema = z
  .object({ name: collegeName.optional(), shortCode: shortCode.optional(), active: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type CollegeUpdateInput = z.infer<typeof CollegeUpdateSchema>;

export interface CollegeDto {
  id: string;
  name: string;
  shortCode: string;
  active: boolean;
  driveCount: number;
}

// ---- Rounds ---------------------------------------------------------------------

const roundName = z.string().trim().max(60).nullable().optional();

export const RoundCreateSchema = z.object({ name: roundName });
export type RoundCreateInput = z.infer<typeof RoundCreateSchema>;

export const RoundSettingsSchema = z.object({
  name: roundName,
  durationMinutes: z.number().int().min(10).max(240),
  /** Marks deducted per wrong MCQ answer, steps of 0.25; 0 = off. Omitted keeps the stored value. */
  mcqNegativeMarks: z
    .number()
    .min(0)
    .max(50)
    .refine((n) => Number.isInteger(n * 4), { message: 'Use steps of 0.25' })
    .optional(),
  /** Composite-score weights (docs/ai-evaluation.md); omitted keeps the stored ones. */
  weights: CompositeWeightsSchema.optional(),
});
export type RoundSettingsInput = z.infer<typeof RoundSettingsSchema>;

// ---- Drives ---------------------------------------------------------------------

export const DRIVE_BATCH_MAX = 60;
const batch = z.string().trim().min(1, 'Enter a batch, e.g. "Nov 2026"').max(DRIVE_BATCH_MAX);
const instant = z.string().datetime({ offset: true }).nullable().optional();
const windowOrdered = (v: { windowStart?: string | null; windowEnd?: string | null }): boolean =>
  !v.windowStart || !v.windowEnd || new Date(v.windowEnd).getTime() > new Date(v.windowStart).getTime();
const windowMessage = { message: 'Window end must be after window start', path: ['windowEnd'] };

export const DriveCreateSchema = z
  .object({
    collegeId: uuid,
    batch,
    windowStart: instant,
    windowEnd: instant,
    instructions: z.string().max(10_000).default(''),
    isOpen: z.boolean().default(false),
  })
  .refine(windowOrdered, windowMessage);
export type DriveCreateInput = z.infer<typeof DriveCreateSchema>;

export const DriveUpdateSchema = z
  .object({
    batch: batch.optional(),
    windowStart: instant,
    windowEnd: instant,
    instructions: z.string().max(10_000).optional(),
    isOpen: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' })
  .refine(windowOrdered, windowMessage);
export type DriveUpdateInput = z.infer<typeof DriveUpdateSchema>;

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const DriveListQuerySchema = z.object({
  jobRoleId: uuid.optional(),
  roundId: uuid.optional(),
  collegeId: uuid.optional(),
  active: bool.optional(),
});
export type DriveListQuery = z.infer<typeof DriveListQuerySchema>;

export interface DriveDto {
  id: string;
  roundId: string;
  roundNumber: number;
  jobRoleId: string;
  jobRoleName: string;
  jobProfileType: JobProfileType;
  college: { id: string; name: string; shortCode: string };
  batch: string;
  displayName: string;
  windowStart: string | null;
  windowEnd: string | null;
  isOpen: boolean;
  instructions: string;
  active: boolean;
  counts: { candidates: number; started: number };
}

export interface RoundDto {
  id: string;
  roundNumber: number;
  name: string | null;
  durationMinutes: number;
  questionsLocked: boolean;
  weights: CompositeWeights;
  /** Marks deducted per wrong MCQ answer (0 = no negative marking). */
  mcqNegativeMarks: number;
  counts: { questions: number };
  /** Super Admin only; absent for evaluators (they never see colleges). */
  drives?: DriveDto[];
}

/** "Quant Analyst · Round 1 · IITG · Nov 2026". */
export function driveDisplayName(d: { jobRoleName: string; roundNumber: number; collegeShortCode: string; batch: string }): string {
  return `${d.jobRoleName} · Round ${d.roundNumber} · ${d.collegeShortCode} · ${d.batch}`;
}

// ---- Questions copy and promotion ---------------------------------------------------

/** Copy another round's active questions into this one (e.g. an internship reusing the placement exam). */
export const CopyQuestionsSchema = z.object({ fromRoundId: uuid, replace: z.boolean().default(false) });
export type CopyQuestionsInput = z.infer<typeof CopyQuestionsSchema>;

export interface CopyQuestionsResultDto {
  copied: number;
  skippedDuplicates: number;
}

export type PromoteSkipReason = 'NOT_SHORTLISTED' | 'SAME_ROUND_BATCH';

/** "Move shortlisted to Round n+1": same college and batch, round n+1. */
export interface PromoteResultDto {
  targetDriveId: string;
  moved: number;
  alreadyThere: number;
  skipped: { candidateId: string; candidateCode: string; reason: PromoteSkipReason }[];
}
