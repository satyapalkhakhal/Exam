// src/api/admin/emails.ts
// Why: Super Admin email templates, previews, manual sends and the dispatch log
// (docs/email-templates.md). Types come from @exam/shared.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EmailDispatchDto, EmailDispatchListQuery, EmailPreviewInput, EmailRenderedDto, EmailSendInput, EmailSendResultDto,
  EmailTemplateDto, EmailTemplateKey, EmailTemplateUpdateInput, Paginated,
} from '@exam/shared';
import { ApiError, apiFetch } from '@/lib/api';

export const emailTemplatesKey = ['admin', 'email-templates'] as const;

export function useEmailTemplates() {
  return useQuery({
    queryKey: emailTemplatesKey,
    queryFn: () => apiFetch<{ templates: EmailTemplateDto[] }>('admin', '/email-templates').then((r) => r.templates),
  });
}

export function useSaveEmailTemplate(key: EmailTemplateKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailTemplateUpdateInput) => apiFetch<EmailTemplateDto>('admin', `/email-templates/${key}`, { method: 'PUT', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: emailTemplatesKey }),
  });
}

export function useResetEmailTemplate(key: EmailTemplateKey) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<EmailTemplateDto>('admin', `/email-templates/${key}/reset`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: emailTemplatesKey }),
  });
}

export function useEmailPreview(key: EmailTemplateKey, input: EmailPreviewInput, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'email-preview', key, input],
    queryFn: () => apiFetch<EmailRenderedDto>('admin', `/email-templates/${key}/preview`, { method: 'POST', json: input }),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 30_000,
  });
}

export function useSendTestEmail(key: EmailTemplateKey) {
  return useMutation({
    mutationFn: (input: EmailPreviewInput) => apiFetch<{ sentTo: string }>('admin', `/email-templates/${key}/test`, { method: 'POST', json: input }),
  });
}

export function useSendEmails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EmailSendInput) => apiFetch<EmailSendResultDto>('admin', '/emails/send', { method: 'POST', json: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'emails'] }),
  });
}

export function useEmailDispatches(query: Partial<EmailDispatchListQuery>) {
  return useQuery({
    queryKey: ['admin', 'emails', query],
    queryFn: () => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') p.set(k, String(v));
      return apiFetch<Paginated<EmailDispatchDto>>('admin', `/emails?${p.toString()}`);
    },
    placeholderData: keepPreviousData,
    // Queued emails flip to SENT/FAILED shortly after; poll gently while any is queued.
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.status === 'QUEUED') ? 5_000 : false),
  });
}

export const isEmailNotConfigured = (e: unknown): boolean => e instanceof ApiError && e.code === 'EMAIL_NOT_CONFIGURED';
