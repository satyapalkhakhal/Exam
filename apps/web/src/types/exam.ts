// src/types/exam.ts
// The exam-engine payloads (plan Task 10 Interfaces). Defined here because @exam/shared
// does not export an exam schema yet; keep in step with the API's exam.schemas.ts.

export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | (string & {});

export type ExamQuestionType = 'WRITTEN' | 'MCQ';

export interface ExamAnswer {
  text: string;
  wordCount: number;
  /** MCQ: the chosen option (index in `options`), null when none. */
  selectedOption: number | null;
  clientSeq: number;
  markedForReview: boolean;
  visited: boolean;
  lastSavedAt: string | null;
}

export interface ExamQuestion {
  attemptQuestionId: string;
  order: number;
  type: ExamQuestionType;
  text: string;
  /** MCQ: 4 options in the order this candidate sees them; [] for written. Never says which is correct. */
  options: string[];
  maxMarks: number;
  answer: ExamAnswer;
}

export interface ExamState {
  attemptId: string;
  /** Only returned by start and resume. */
  sessionId?: string;
  status: AttemptStatus;
  serverNow: string;
  startedAt: string;
  endsAt: string;
  durationMinutes: number;
  /** Marks deducted per wrong MCQ answer (0 = none). */
  mcqNegativeMarks: number;
  questions: ExamQuestion[];
}

/** The server's hard limit on one answer (PUT /exam/answers/:id). */
export const ANSWER_MAX_CHARS = 20_000;
