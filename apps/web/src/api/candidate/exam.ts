// src/api/candidate/exam.ts
// Why: the exam-engine calls (plan Task 10). /exam/info is ASSUMED (the dashboard needs
// duration/window/instructions/isOpen). start/resume issue the attempt-session id, which is
// kept in sessionStorage under exam:session:{attemptId}: a refresh in the same tab keeps it,
// a new tab has none and must take over via /exam/resume (a duplicated tab, which inherits
// sessionStorage, is caught by tabPresence). Saves and events carry it.
// The pagehide paths can't await anything, so answers go by sendBeacon (text/plain JSON, the
// beacon endpoint) and events by a keepalive fetch.

import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SavePayload, SaveResult } from '@/lib/autosave';
import type { QueuedEvent } from '@/lib/eventQueue';
import { tabPresenceFor } from '@/lib/tabPresence';
import { markCandidateStatus } from '@/stores/candidateAuth';
import type { ExamState } from '@/types/exam';
import type { LocationPayload } from './location';

export interface ExamInfo {
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  isOpen: boolean;
  serverNow: string;
}

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
      // Without sessionStorage a refresh simply takes over again via /exam/resume.
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

export function useExamInfo() {
  return useQuery({
    queryKey: ['candidate', 'exam', 'info'],
    queryFn: () => apiFetch<ExamInfo>('candidate', '/exam/info'),
    refetchOnWindowFocus: true,
  });
}

export const getExamState = () => apiFetch<ExamState>('candidate', '/exam');

export const resumeExam = () =>
  apiFetch<ExamState>('candidate', '/exam/resume', { method: 'POST' }).then(rememberSession);

export function useStartExam() {
  return useMutation({
    mutationFn: (location: LocationPayload) =>
      apiFetch<ExamState>('candidate', '/exam/start', { method: 'POST', json: { location } })
        .then(rememberSession)
        .then((state) => {
          markCandidateStatus(state.status);
          return state;
        }),
  });
}

export function useResumeExam() {
  return useMutation({ mutationFn: resumeExam });
}

const answerBody = (sessionId: string, p: SavePayload) => {
  const { attemptQuestionId: _id, ...rest } = p;
  return { sessionId, ...rest };
};

export const saveAnswer = (sessionId: string, p: SavePayload) =>
  apiFetch<SaveResult>('candidate', `/exam/answers/${encodeURIComponent(p.attemptQuestionId)}`, {
    method: 'PUT',
    json: answerBody(sessionId, p),
  });

/** pagehide save. A string body goes as text/plain, which the beacon endpoint parses as JSON. */
export function beaconAnswer(sessionId: string, p: SavePayload): boolean {
  const url = `/api/candidate/exam/answers/${encodeURIComponent(p.attemptQuestionId)}/beacon`;
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

export const postEvents = (sessionId: string, events: QueuedEvent[]) =>
  apiFetch<unknown>('candidate', '/exam/events', { method: 'POST', json: { sessionId, events } }).then(() => undefined);

export function beaconEvents(sessionId: string, events: QueuedEvent[]): void {
  try {
    void fetch('/api/candidate/exam/events', {
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

export const submitExam = (sessionId: string) =>
  apiFetch<unknown>('candidate', '/exam/submit', { method: 'POST', json: { sessionId } });
