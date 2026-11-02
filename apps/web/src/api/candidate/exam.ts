// src/api/candidate/exam.ts
// Why: the exam-engine calls (plan Task 10), all scoped by applicationId (docs/multi-exam.md):
// a candidate may hold several applications, one exam per job role. The per-exam details the
// dashboards need come from GET /candidate/exams[/:applicationId]. start/resume issue the attempt-session id, which is
// kept in sessionStorage under exam:session:{attemptId}: a refresh in the same tab keeps it,
// a new tab has none and must take over via /resume (a duplicated tab, which inherits
// sessionStorage, is caught by tabPresence). Saves and events carry it.
// The pagehide paths can't await anything, so answers go by sendBeacon (text/plain JSON, the
// beacon endpoint) and events by a keepalive fetch.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SavePayload, SaveResult } from '@/lib/autosave';
import type { QueuedEvent } from '@/lib/eventQueue';
import { tabPresenceFor } from '@/lib/tabPresence';
import type { CandidateExamDetailDto, CandidateExamListDto, ExamSummaryDto } from '@exam/shared';
import type { ExamState } from '@/types/exam';
import type { LocationPayload } from './location';

const sessionKey = (attemptId: string) => `exam:session:${attemptId}`;

export function readSessionId(attemptId: string): string | null {
  try {
    return sessionStorage.getItem(sessionKey(attemptId));
  } catch {
    return null;
  }
}

function rememberSession(state: ExamState): ExamState {
  if (state.sessionId) {
    try {
      sessionStorage.setItem(sessionKey(state.attemptId), state.sessionId);
    } catch {
      // Without sessionStorage a refresh simply takes over again via /resume.
    }
    // A new session supersedes every other tab: tell them now rather than on their next save.
    tabPresenceFor(state.attemptId).announceTakeover();
  }
  return state;
}

export function forgetSession(attemptId: string): void {
  try {
    sessionStorage.removeItem(sessionKey(attemptId));
  } catch {
    /* nothing to forget */
  }
}

const base = (applicationId: string) => `/exams/${encodeURIComponent(applicationId)}`;
const rawBase = (applicationId: string) => `/api/candidate/exams/${encodeURIComponent(applicationId)}`;

export const examsKey = ['candidate', 'exams'] as const;

export function useCandidateExams() {
  return useQuery({
    queryKey: [...examsKey, 'list'],
    queryFn: () => apiFetch<CandidateExamListDto>('candidate', '/exams'),
    refetchOnWindowFocus: true,
  });
}

export function useCandidateExam(applicationId: string | undefined) {
  return useQuery({
    queryKey: [...examsKey, 'detail', applicationId],
    queryFn: () => apiFetch<CandidateExamDetailDto>('candidate', base(applicationId ?? '')),
    enabled: Boolean(applicationId),
    refetchOnWindowFocus: true,
  });
}

/** Progress changed (started, submitted): the list and detail must be refetched, not served stale. */
export function useInvalidateExams() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: examsKey });
}

export const getExamState = (applicationId: string) => apiFetch<ExamState>('candidate', `${base(applicationId)}/state`);

/** The candidate's own submission receipt (times and counts only). */
export function useExamSummary(applicationId: string | undefined) {
  return useQuery({
    queryKey: [...examsKey, 'summary', applicationId],
    queryFn: () => apiFetch<ExamSummaryDto>('candidate', `${base(applicationId ?? '')}/summary`),
    enabled: Boolean(applicationId),
  });
}

export const resumeExam = (applicationId: string) =>
  apiFetch<ExamState>('candidate', `${base(applicationId)}/resume`, { method: 'POST' }).then(rememberSession);

export function useStartExam(applicationId: string) {
  const invalidate = useInvalidateExams();
  return useMutation({
    mutationFn: (location: LocationPayload) =>
      apiFetch<ExamState>('candidate', `${base(applicationId)}/start`, { method: 'POST', json: { location } }).then(rememberSession),
    onSuccess: () => void invalidate(),
  });
}

export function useResumeExam(applicationId: string) {
  return useMutation({ mutationFn: () => resumeExam(applicationId) });
}

const answerBody = (sessionId: string, p: SavePayload) => {
  const { attemptQuestionId: _id, ...rest } = p;
  return { sessionId, ...rest };
};

export const saveAnswer = (applicationId: string, sessionId: string, p: SavePayload) =>
  apiFetch<SaveResult>('candidate', `${base(applicationId)}/answers/${encodeURIComponent(p.attemptQuestionId)}`, {
    method: 'PUT',
    json: answerBody(sessionId, p),
  });

/** pagehide save. A string body goes as text/plain, which the beacon endpoint parses as JSON. */
export function beaconAnswer(applicationId: string, sessionId: string, p: SavePayload): boolean {
  const url = `${rawBase(applicationId)}/answers/${encodeURIComponent(p.attemptQuestionId)}/beacon`;
  const body = JSON.stringify(answerBody(sessionId, p));
  try {
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url, body)) return true;
  } catch {
    /* fall through to keepalive */
  }
  try {
    void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'include', headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
    return true;
  } catch {
    // Over the browser's keepalive budget: the storage mirror restores it on the next load.
    return false;
  }
}

export const postEvents = (applicationId: string, sessionId: string, events: QueuedEvent[]) =>
  apiFetch<unknown>('candidate', `${base(applicationId)}/events`, { method: 'POST', json: { sessionId, events } }).then(() => undefined);

export function beaconEvents(applicationId: string, sessionId: string, events: QueuedEvent[]): void {
  try {
    void fetch(`${rawBase(applicationId)}/events`, {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, events }),
    }).catch(() => {});
  } catch {
    /* best effort on unload */
  }
}

export const submitExam = (applicationId: string, sessionId: string) =>
  apiFetch<unknown>('candidate', `${base(applicationId)}/submit`, { method: 'POST', json: { sessionId } });
