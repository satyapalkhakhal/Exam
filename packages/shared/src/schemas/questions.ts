// schemas/questions.ts
// Zod contracts and DTOs for questions and the question import, shared by the
// API and the admin forms. Marks run 0.5..100 in steps of 0.5 (design §5).

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

export const QuestionCreateSchema = z.object({
  roundId: z.string().uuid(),
  questionText: text,
  maxMarks: marks,
  evaluatorGuidance: guidance,
});
export type QuestionCreateInput = z.infer<typeof QuestionCreateSchema>;

export const QuestionUpdateSchema = z
  .object({
    questionText: text.optional(),
    maxMarks: marks.optional(),
    evaluatorGuidance: z.string().trim().max(5000).nullable().optional(),
    displayOrder: z.number().int().min(0).max(100_000).optional(),
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
  questionText: string;
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
  /** Candidate import only: valid rows that register an existing person for the exam. */
  addedToExisting?: number;
}

export interface ImportPreviewDto<T> {
  previewId: string;
  fileHash: string;
  summary: ImportSummary;
  valid: T[];
  errors: ImportRowError[];
  duplicates: ImportRowDuplicate[];
}

export interface QuestionImportRow {
  row: number;
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
}

export interface ImportResultDto {
  imported: number;
  skipped: number;
}
