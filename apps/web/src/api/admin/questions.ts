// src/api/admin/questions.ts
// Why: question CRUD, ordering, lock/unlock and CSV/XLSX import, per round (spec
// 2026-11-10: the question bank belongs to a round of a job profile, shared by
// every college's drive of that round).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Paged } from './users';
import type { ImportPreview, ImportResult } from '@/lib/importState';
import { rolesKey } from './roles';

import type { QuestionDto } from '@exam/shared';
import type { QuestionPayload } from '@/lib/mcqForm';

/** type, options (A–D) and the correct one come from the API for admins only. */
export type Question = QuestionDto;

export type QuestionInput = QuestionPayload;

export const QUESTION_TEMPLATE_URL = '/api/admin/questions/template.csv';
export const QUESTION_SAMPLE_URL = '/api/admin/questions/sample.csv';

const key = (roundId: string) => ['admin', 'questions', roundId] as const;

export function useQuestions(roundId: string) {
  return useQuery({
    queryKey: key(roundId),
    queryFn: async () =>
      (await apiFetch<Paged<Question>>('admin', `/questions?roundId=${encodeURIComponent(roundId)}&pageSize=500`)).items,
    enabled: roundId !== '',
  });
}

function useInvalidate(roundId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(roundId) });
    void qc.invalidateQueries({ queryKey: rolesKey });
  };
}

export function useSaveQuestion(roundId: string) {
  const done = useInvalidate(roundId);
  return useMutation({
    mutationFn: ({ id, ...body }: QuestionInput & { id?: string }) =>
      id
        ? apiFetch<Question>('admin', `/questions/${id}`, { method: 'PATCH', json: body })
        : apiFetch<Question>('admin', '/questions', { method: 'POST', json: { roundId, ...body } }),
    onSuccess: done,
  });
}

export function useSetQuestionActive(roundId: string) {
  const done = useInvalidate(roundId);
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<Question>('admin', `/questions/${id}/active`, { method: 'PATCH', json: { active } }),
    onSuccess: done,
  });
}

export function useReorderQuestions(roundId: string) {
  const qc = useQueryClient();
  const done = useInvalidate(roundId);
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<unknown>('admin', `/rounds/${roundId}/questions/order`, { method: 'PATCH', json: { ids } }),
    onSuccess: done,
    // Put the server's order back if the save was refused (e.g. 423 locked).
    onError: () => void qc.invalidateQueries({ queryKey: key(roundId) }),
  });
}

export function useUnlockQuestions(roundId: string) {
  const done = useInvalidate(roundId);
  return useMutation({
    mutationFn: (reason: string) =>
      apiFetch<unknown>('admin', `/rounds/${roundId}/questions/unlock`, { method: 'POST', json: { reason } }),
    onSuccess: done,
  });
}

export function previewQuestionImport(file: File, roundId: string): Promise<ImportPreview<Record<string, unknown>>> {
  const body = new FormData();
  body.append('file', file);
  body.append('roundId', roundId);
  return apiFetch('admin', '/questions/import/preview', { method: 'POST', body });
}

export function confirmQuestionImport(a: { previewId: string; force?: boolean }): Promise<ImportResult> {
  return apiFetch('admin', '/questions/import/confirm', { method: 'POST', json: a.force ? a : { previewId: a.previewId } });
}
