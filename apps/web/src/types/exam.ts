// src/types/exam.ts
// The exam-engine payloads (plan Task 10 Interfaces). Defined here because @exam/shared
// does not export an exam schema yet; keep in step with the API's exam.schemas.ts.

export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | (string & {});

export interface ExamAnswer {
  text: string;
  wordCount: number;
  clientSeq: number;
  markedForReview: boolean;
  visited: boolean;
  lastSavedAt: string | null;
}

export interface ExamQuestion {
  attemptQuestionId: string;
  order: number;
  text: string;
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
  questions: ExamQuestion[];
}

/** The server's hard limit on one answer (PUT /exam/answers/:id). */
export const ANSWER_MAX_CHARS = 20_000;
