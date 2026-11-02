// schemas/candidateExams.ts
// Contracts for the candidate's "My exams" dashboard (docs/multi-exam.md). A
// person signs in once (a candidate account, keyed by email) and may hold
// several applications, one per job role; each application sits its role's
// exam once. Every exam-engine route is scoped by :applicationId, which the
// API checks belongs to the signed-in account.

import { z } from 'zod';

export const ApplicationParamsSchema = z.object({ applicationId: z.string().uuid() });
export const ApplicationQuestionParamsSchema = ApplicationParamsSchema.extend({ attemptQuestionId: z.string().uuid() });

/**
 * What the candidate is told about one application. Admin decisions
 * (EVALUATED / SHORTLISTED / REJECTED) are never exposed: all of them read as
 * SUBMITTED here.
 */
export type CandidateExamProgress = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED';

export interface CandidateExamAttemptDto {
  attemptId: string;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED';
  submitType: 'MANUAL' | 'AUTO' | null;
  startedAt: string;
  endsAt: string;
  submittedAt: string | null;
  questionCount: number;
  answeredCount: number;
}

export interface CandidateExamDto {
  /** The application (candidates.id). Only eligible applications are listed. */
  applicationId: string;
  candidateCode: string;
  jobRole: { id: string; name: string };
  progress: CandidateExamProgress;
  locationExempt: boolean;
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  isOpen: boolean;
  instructions: string;
  /** The current (non-RESET) attempt, if any. An expired IN_PROGRESS attempt is settled before it is returned. */
  attempt: CandidateExamAttemptDto | null;
}

export interface CandidateExamListDto {
  serverNow: string;
  exams: CandidateExamDto[];
}

export interface CandidateExamDetailDto {
  serverNow: string;
  exam: CandidateExamDto;
}
