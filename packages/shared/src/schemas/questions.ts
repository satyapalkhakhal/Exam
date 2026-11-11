// schemas/questions.ts
// Zod contracts and DTOs for questions and the question import, shared by the
// API and the admin forms. Marks run 0.5..100 in steps of 0.5 (design §5).
// A question is WRITTEN (marked by an evaluator) or MCQ: exactly 4 options (A–D),
// one correct, auto-marked (spec 2026-11-10 MCQ questions).

import { z } from 'zod';

const text = z.string().trim().min(10).max(5000);
const marks = z
  .number()
  .min(0.5)
  .max(100)
  .refine((n) => Number.isInteger(n * 2), { message: 'Marks must be in steps of 0.5' });
const guidance = z
  .string()
  .trim()
  .max(5000)
  .nullable()
  .optional()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));

export const QUESTION_TYPES = ['WRITTEN', 'MCQ'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const MCQ_OPTION_COUNT = 4;
export const MCQ_LETTERS = ['A', 'B', 'C', 'D'] as const;
/** 0 -> "A" … 3 -> "D". */
export const mcqLetter = (i: number): string => MCQ_LETTERS[i] ?? '?';

const optionText = z.string().trim().min(1, 'Every option needs text').max(1000);
/** Exactly 4 non-empty options, no two the same (ignoring case and spaces). */
export const McqOptionsSchema = z
  .array(optionText)
  .length(MCQ_OPTION_COUNT, `An MCQ has exactly ${MCQ_OPTION_COUNT} options`)
  .refine((o) => new Set(o.map((x) => x.toLowerCase().replace(/\s+/g, ' '))).size === o.length, {
    message: 'Options must all be different',
  });
const correctOption = z.number().int().min(0).max(MCQ_OPTION_COUNT - 1);

export const QuestionCreateSchema = z
  .object({
    roundId: z.string().uuid(),
    type: z.enum(QUESTION_TYPES).default('WRITTEN'),
    questionText: text,
    maxMarks: marks,
    evaluatorGuidance: guidance,
    options: McqOptionsSchema.optional(),
    correctOption: correctOption.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'MCQ') {
      if (!v.options) ctx.addIssue({ code: 'custom', path: ['options'], message: `An MCQ has exactly ${MCQ_OPTION_COUNT} options` });
      if (v.correctOption === undefined) ctx.addIssue({ code: 'custom', path: ['correctOption'], message: 'Choose the correct option' });
    } else {
      if (v.options !== undefined) ctx.addIssue({ code: 'custom', path: ['options'], message: 'A written question has no options' });
      if (v.correctOption !== undefined) ctx.addIssue({ code: 'custom', path: ['correctOption'], message: 'A written question has no correct option' });
    }
  });
export type QuestionCreateInput = z.infer<typeof QuestionCreateSchema>;

export const QuestionUpdateSchema = z
  .object({
    questionText: text.optional(),
    maxMarks: marks.optional(),
    evaluatorGuidance: z.string().trim().max(5000).nullable().optional(),
    displayOrder: z.number().int().min(0).max(100_000).optional(),
    /** MCQ only (the API refuses them on a written question). The type itself never changes. */
    options: McqOptionsSchema.optional(),
    correctOption: correctOption.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type QuestionUpdateInput = z.infer<typeof QuestionUpdateSchema>;

export const QuestionActiveSchema = z.object({ active: z.boolean() });

export const QuestionOrderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
export type QuestionOrderInput = z.infer<typeof QuestionOrderSchema>;

export const QuestionUnlockSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type QuestionUnlockInput = z.infer<typeof QuestionUnlockSchema>;

export const QuestionListQuerySchema = z.object({
  roundId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
});
export type QuestionListQuery = z.infer<typeof QuestionListQuerySchema>;

export const ImportPreviewBodySchema = z.object({ roundId: z.string().uuid() });

export const ImportConfirmSchema = z.object({
  previewId: z.string().uuid(),
  force: z.boolean().optional(),
});
export type ImportConfirmInput = z.infer<typeof ImportConfirmSchema>;

export interface QuestionDto {
  id: string;
  roundId: string;
  type: QuestionType;
  questionText: string;
  /** MCQ: the 4 options in A–D order; [] for written. */
  options: string[];
  /** MCQ: index of the correct option; null for written. Admin only, never sent to candidates. */
  correctOption: number | null;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
  active: boolean;
}

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface ImportRowDuplicate {
  row: number;
  reason: 'IN_FILE' | 'EXISTS';
}

export interface ImportSummary {
  total: number;
  valid: number;
  errors: number;
  duplicates: number;
  /** Candidate import with "update existing" only: rows that update an existing candidate. */
  updates?: number;
}

export interface ImportPreviewDto<T> {
  previewId: string;
  fileHash: string;
  summary: ImportSummary;
  valid: T[];
  errors: ImportRowError[];
  duplicates: ImportRowDuplicate[];
  /** Candidate import with "update existing" only. */
  updates?: T[];
  /** Candidate import: row numbers of valid rows that attach to an existing account under a new role. */
  linkedRows?: number[];
}

export interface QuestionImportRow {
  row: number;
  type: QuestionType;
  questionText: string;
  /** MCQ: 4 options in A–D order; [] for written. */
  options: string[];
  correctOption: number | null;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
}

export interface ImportResultDto {
  imported: number;
  skipped: number;
  /** Candidate import with "update existing" only: existing candidates moved/updated. */
  updated?: number;
}
