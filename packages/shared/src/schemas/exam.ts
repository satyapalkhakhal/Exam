// schemas/exam.ts
// Zod contracts for the candidate exam engine (design §7.4–§7.6), shared by the
// API (validation) and the exam screen. The server owns the clock and the
// session: every save and event batch carries the attempt-session id issued by
// start/resume, and saves carry a client sequence so late ones are ignored.

import { z } from 'zod';
import { LocationPermissionSchema, LocationStageSchema } from './auth.js';

/** The hard limit on one answer, in UTF-16 code units (what a textarea's maxLength counts). */
export const ANSWER_MAX_CHARS = 20_000;
export const EXAM_EVENTS_MAX_BATCH = 50;

export const EXAM_EVENT_TYPES = [
  'QUESTION_VIEWED',
  'PASTE_ATTEMPT',
  'COPY_ATTEMPT',
  'CUT_ATTEMPT',
  'DROP_ATTEMPT',
  'CONTEXT_MENU',
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'PAGE_UNLOAD',
  'NETWORK_OFFLINE',
  'NETWORK_ONLINE',
] as const;
export const ExamEventTypeSchema = z.enum(EXAM_EVENT_TYPES);
export type ExamEventType = z.infer<typeof ExamEventTypeSchema>;

const sessionId = z.string().min(1).max(100);
const INT32_MAX = 2_147_483_647;

// The start location is the same capture as at login; `stage` may be sent and
// is ignored (the server always records EXAM_START).
export const ExamStartSchema = z.object({
  location: z
    .object({
      stage: LocationStageSchema.optional(),
      permission: LocationPermissionSchema,
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      accuracyM: z.number().min(0).max(1_000_000).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.permission !== 'GRANTED') return;
      if (v.latitude === undefined) ctx.addIssue({ code: 'custom', path: ['latitude'], message: 'latitude is required when permission is GRANTED' });
      if (v.longitude === undefined) ctx.addIssue({ code: 'custom', path: ['longitude'], message: 'longitude is required when permission is GRANTED' });
    }),
});
export type ExamStartInput = z.infer<typeof ExamStartSchema>;

export const SaveAnswerSchema = z.object({
  sessionId,
  clientSeq: z.number().int().min(1).max(INT32_MAX),
  text: z.string().max(ANSWER_MAX_CHARS),
  typedChars: z.number().int().min(0).max(INT32_MAX),
  /** Characters brought back by Undo/Redo, up to what was deleted: counts toward growth, not the typing rate. */
  restoredChars: z.number().int().min(0).max(INT32_MAX).optional(),
  intervalMs: z.number().int().min(0).max(INT32_MAX),
  markedForReview: z.boolean().optional(),
  visited: z.boolean().optional(),
});
export type SaveAnswerInput = z.infer<typeof SaveAnswerSchema>;

export const AttemptQuestionParamsSchema = z.object({ attemptQuestionId: z.string().uuid() });

const METADATA_MAX_JSON = 2_000;
export const ExamEventsSchema = z.object({
  sessionId,
  events: z
    .array(
      z.object({
        type: ExamEventTypeSchema,
        questionId: z.string().uuid().optional(),
        at: z.string().datetime({ offset: true }),
        metadata: z
          .record(z.unknown())
          .optional()
          .refine((m) => m === undefined || JSON.stringify(m).length <= METADATA_MAX_JSON, 'metadata is too large'),
      }),
    )
    .min(1)
    .max(EXAM_EVENTS_MAX_BATCH),
});
export type ExamEventsInput = z.infer<typeof ExamEventsSchema>;

export const SubmitExamSchema = z.object({ sessionId });

export interface ExamAnswerState {
  text: string;
  wordCount: number;
  clientSeq: number;
  markedForReview: boolean;
  visited: boolean;
  /** ISO time of the last accepted save; null when the answer was never saved. */
  lastSavedAt: string | null;
}

export interface ExamQuestionState {
  attemptQuestionId: string;
  order: number;
  text: string;
  maxMarks: number;
  answer: ExamAnswerState;
}

export interface ExamState {
  attemptId: string;
  /** Only returned by start and resume. */
  sessionId?: string;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED';
  serverNow: string;
  startedAt: string;
  endsAt: string;
  durationMinutes: number;
  questions: ExamQuestionState[];
}

export type SaveAnswerResult = { accepted: true; serverNow: string; lastSavedAt: string } | { accepted: false; reason: 'STALE' };
