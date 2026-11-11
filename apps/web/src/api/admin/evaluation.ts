// src/api/admin/evaluation.ts
// Why: submissions list, the marking screen and its lock/save/reopen calls (plan Task 11).
// The plan gives toSubmissionView/toMarkingView but not DTO field types, nor a GET for one
// attempt; those are assumed (GET /submissions/:attemptId) and listed in task-17-report.md.
// PII fields are optional: the API only sends them to a Super Admin.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { AI_FILTERS, AiAttemptSummaryDto, AiQuestionScoreDto } from '@exam/shared';
import type { Paged } from './users';

export type AiFilter = (typeof AI_FILTERS)[number];
export type EvaluationFilter = 'PENDING' | 'DRAFT' | 'SUBMITTED';
export const EVALUATION_FILTERS: EvaluationFilter[] = ['PENDING', 'DRAFT', 'SUBMITTED'];

export interface SaPii {
  candidateId: string;
  fullName: string;
  email: string;
  rollNumber: string | null;
  majorCpi: number | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  programme: string | null;
  discipline: string | null;
}

export interface SubmissionRow extends Partial<SaPii> {
  attemptId: string;
  candidateCode: string;
  jobRole: string;
  jobProfileType: 'PLACEMENT' | 'INTERNSHIP';
  roundNumber: number;
  /** Super Admin only (college + batch are hidden from Evaluators). */
  driveDisplayName?: string;
  submittedAt: string | null;
  timeTakenSec: number | null;
  submitType: string;
  flagCounts: Record<string, number>;
  /** Other candidates who started within 100 m and ±2 h; null without a start location. */
  nearbyCount: number | null;
  evaluationStatus: EvaluationFilter;
  totalMarks?: number | null;
  /** MCQ subtotal (auto-marked) and its max; null / 0 when the test has no MCQs. */
  mcqMarks: number | null;
  mcqMaxMarks: number;
  ai: AiAttemptSummaryDto;
}

export interface SubmissionFilters {
  jobRoleId: string;
  roundId: string;
  /** Super Admin only: the API refuses a drive or college filter from an Evaluator. */
  driveId: string;
  /** Campus dashboard links (spec 2026-11-11). collegeId and batch are Super Admin only. */
  collegeId: string;
  batch: string;
  jobProfileType: '' | 'PLACEMENT' | 'INTERNSHIP';
  roundNumber: string;
  evaluation: '' | EvaluationFilter;
  ai: '' | AiFilter;
  search: string;
}

export function useSubmissions(f: SubmissionFilters, page: number, pageSize: number) {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (f.jobRoleId) q.set('jobRoleId', f.jobRoleId);
  if (f.roundId) q.set('roundId', f.roundId);
  if (f.driveId) q.set('driveId', f.driveId);
  if (f.collegeId) q.set('collegeId', f.collegeId);
  if (f.batch) q.set('batch', f.batch);
  if (f.jobProfileType) q.set('jobProfileType', f.jobProfileType);
  if (f.roundNumber) q.set('roundNumber', f.roundNumber);
  if (f.evaluation) q.set('evaluation', f.evaluation);
  if (f.ai) q.set('ai', f.ai);
  if (f.search) q.set('search', f.search);
  return useQuery({
    queryKey: ['admin', 'submissions', 'list', q.toString()],
    queryFn: () => apiFetch<Paged<SubmissionRow>>('admin', `/submissions?${q.toString()}`),
    placeholderData: keepPreviousData,
  });
}

export interface MarkingQuestion {
  attemptQuestionId: string;
  order: number;
  type: 'WRITTEN' | 'MCQ';
  text: string;
  /** MCQ, read-only: options as the candidate saw them, their choice, the correct one, the auto mark. */
  options: string[];
  selectedOption: number | null;
  correctOption: number | null;
  autoMarks: number | null;
  maxMarks: number;
  evaluatorGuidance: string | null;
  answer: { text: string; wordCount: number; versions: { savedAt: string; wordCount: number }[] };
  integrity: { pasteAttempts: number; bulkInsert: { at: string; grown: number; typed: number }[] };
  evaluation: { marks: number | null; comment: string | null };
  ai: AiQuestionScoreDto | null;
  acceptedFromAi: boolean;
}

export interface MarkingView extends Partial<SaPii> {
  attemptId: string;
  candidateCode: string;
  jobRole: string;
  submittedAt: string | null;
  evaluationStatus: EvaluationFilter;
  totalMarks?: number | null;
  mcqMarks: number | null;
  mcqMaxMarks: number;
  startedAt: string;
  questions: MarkingQuestion[];
  timeline: TimelineEvent[];
}

/** One exam event (type, time, open question); never IPs or devices. */
export interface TimelineEvent {
  at: string;
  type: string;
  questionOrder: number | null;
  bulk: { grown: number; typed: number } | null;
}

export interface LockInfo {
  lockedBy: { id: string; name: string };
  lockedAt: string;
}

export interface EvaluationItem {
  attemptQuestionId: string;
  marks: number | null;
  comment?: string;
}

export const markingKey = (attemptId: string) => ['admin', 'submissions', 'marking', attemptId] as const;

export function useMarkingView(attemptId: string) {
  return useQuery({
    queryKey: markingKey(attemptId),
    queryFn: () => apiFetch<MarkingView>('admin', `/submissions/${attemptId}`),
    refetchOnWindowFocus: false,
  });
}

export const lockAttempt = (attemptId: string) =>
  apiFetch<LockInfo>('admin', `/submissions/${attemptId}/lock`, { method: 'POST' });

/**
 * Fire-and-forget release for unmount/pagehide. keepalive lets it outlive the page, and going
 * through apiFetch means an expired access cookie is refreshed instead of the release being
 * dropped (which would leave the script locked for 30 minutes).
 */
export function releaseLock(attemptId: string): void {
  void apiFetch<unknown>('admin', `/submissions/${attemptId}/lock`, { method: 'DELETE', keepalive: true, noRedirect: true }).catch(
    () => undefined,
  );
}

export function useSaveEvaluation(attemptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { items: EvaluationItem[]; submit: boolean }) =>
      apiFetch('admin', `/submissions/${attemptId}/evaluation`, { method: 'PUT', json: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'submissions'] }),
  });
}

export function useReopen(attemptId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => apiFetch('admin', `/submissions/${attemptId}/reopen`, { method: 'POST', json: { reason } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}
