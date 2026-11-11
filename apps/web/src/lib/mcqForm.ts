// src/lib/mcqForm.ts
// Why: the question dialog (spec 2026-11-10 MCQ questions) authors written and
// multiple-choice questions in one form. The rules (exactly 4 different options
// A–D, one correct answer) and the payload shape live here as pure functions so
// they are tested and the dialog stays thin. The server checks the same rules.

import { z } from 'zod';
import { MCQ_LETTERS, type QuestionType } from '@exam/shared';

export interface QuestionFormValues {
  type: QuestionType;
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string;
  /** Always 4 entries in the form (A–D); ignored for a written question. */
  options: string[];
  correctOption: number | null;
}

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export const questionFormSchema = z
  .object({
    type: z.enum(['WRITTEN', 'MCQ']),
    questionText: z.string().trim().min(10, 'At least 10 characters').max(5000, 'At most 5,000 characters'),
    maxMarks: z
      .number({ invalid_type_error: 'Enter marks' })
      .min(0.5, 'At least 0.5')
      .max(100, 'At most 100')
      .refine((n) => Math.round(n * 2) === n * 2, 'Use steps of 0.5'),
    evaluatorGuidance: z.string().max(5000, 'At most 5,000 characters'),
    options: z.array(z.string()),
    correctOption: z.number().int().min(0).max(3).nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.type !== 'MCQ') return;
    const seen = new Set<string>();
    v.options.forEach((o, i) => {
      if (!o.trim()) ctx.addIssue({ code: 'custom', path: ['options', i], message: `Enter option ${MCQ_LETTERS[i]}` });
      else if (o.trim().length > 1000) ctx.addIssue({ code: 'custom', path: ['options', i], message: 'At most 1,000 characters' });
      else if (seen.has(normalise(o))) ctx.addIssue({ code: 'custom', path: ['options', i], message: 'Options must all be different' });
      seen.add(normalise(o));
    });
    if (v.correctOption === null) ctx.addIssue({ code: 'custom', path: ['correctOption'], message: 'Choose the correct answer' });
  });

export interface QuestionPayload {
  type?: QuestionType;
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  options?: string[];
  correctOption?: number;
}

/** Create sends the type; edit never does (it cannot change). Options only for an MCQ. */
export function toQuestionPayload(v: QuestionFormValues, editing: boolean): QuestionPayload {
  const out: QuestionPayload = {
    ...(editing ? {} : { type: v.type }),
    questionText: v.questionText.trim(),
    maxMarks: v.maxMarks,
    evaluatorGuidance: v.evaluatorGuidance.trim() || null,
  };
  if (v.type === 'MCQ') {
    out.options = v.options.map((o) => o.trim());
    out.correctOption = v.correctOption ?? undefined;
  }
  return out;
}

/** "A. 4 · B. 6 · C. 7 ✓ · D. 9" for list rows and the import preview. */
export function optionsSummary(options: string[], correct: number | null): string {
  return options.map((o, i) => `${MCQ_LETTERS[i] ?? '?'}. ${o}${i === correct ? ' ✓' : ''}`).join(' · ');
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = { WRITTEN: 'Written', MCQ: 'Multiple choice' };
