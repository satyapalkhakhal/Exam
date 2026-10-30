// src/api/admin/questions.ts
// Why: question CRUD, ordering, lock/unlock and CSV/XLSX import (plan Task 8). The
// Question DTO field names are assumed: questionText, maxMarks, evaluatorGuidance,
// displayOrder, active (they mirror the template columns).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Paged } from './users';
import type { ImportPreview, ImportResult } from '@/lib/importState';
import { rolesKey } from './roles';

export interface Question {
  id: string;
  jobRoleId: string;
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
  active: boolean;
}

export interface QuestionInput {
  questionText: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
}

export const QUESTION_TEMPLATE_URL = '/api/admin/questions/template.csv';
export const QUESTION_SAMPLE_URL = '/api/admin/questions/sample.csv';

const key = (jobRoleId: string) => ['admin', 'questions', jobRoleId] as const;

export function useQuestions(jobRoleId: string) {
  return useQuery({
    queryKey: key(jobRoleId),
    queryFn: async () =>
      (await apiFetch<Paged<Question>>('admin', `/questions?jobRoleId=${encodeURIComponent(jobRoleId)}&pageSize=500`)).items,
    enabled: jobRoleId !== '',
  });
}

function useInvalidate(jobRoleId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(jobRoleId) });
    void qc.invalidateQueries({ queryKey: rolesKey });
  };
}

export function useSaveQuestion(jobRoleId: string) {
  const done = useInvalidate(jobRoleId);
  return useMutation({
    mutationFn: ({ id, ...body }: QuestionInput & { id?: string }) =>
      id
        ? apiFetch<Question>('admin', `/questions/${id}`, { method: 'PATCH', json: body })
        : apiFetch<Question>('admin', '/questions', { method: 'POST', json: { jobRoleId, ...body } }),
    onSuccess: done,
  });
}

export function useSetQuestionActive(jobRoleId: string) {
  const done = useInvalidate(jobRoleId);
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<Question>('admin', `/questions/${id}/active`, { method: 'PATCH', json: { active } }),
    onSuccess: done,
  });
}

export function useReorderQuestions(jobRoleId: string) {
  const qc = useQueryClient();
  const done = useInvalidate(jobRoleId);
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<unknown>('admin', `/roles/${jobRoleId}/questions/order`, { method: 'PATCH', json: { ids } }),
    onSuccess: done,
    // Put the server's order back if the save was refused (e.g. 423 locked).
    onError: () => void qc.invalidateQueries({ queryKey: key(jobRoleId) }),
  });
}

export function useUnlockQuestions(jobRoleId: string) {
  const done = useInvalidate(jobRoleId);
  return useMutation({
    mutationFn: (reason: string) =>
      apiFetch<unknown>('admin', `/roles/${jobRoleId}/questions/unlock`, { method: 'POST', json: { reason } }),
    onSuccess: done,
  });
}

export function previewQuestionImport(file: File, jobRoleId: string): Promise<ImportPreview<Record<string, unknown>>> {
  const body = new FormData();
  body.append('file', file);
  body.append('jobRoleId', jobRoleId);
  return apiFetch('admin', '/questions/import/preview', { method: 'POST', body });
}

export function confirmQuestionImport(a: { previewId: string; force?: boolean }): Promise<ImportResult> {
  return apiFetch('admin', '/questions/import/confirm', { method: 'POST', json: a.force ? a : { previewId: a.previewId } });
}
