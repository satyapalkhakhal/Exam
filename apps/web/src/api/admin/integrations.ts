// src/api/admin/integrations.ts
// Why: Super Admin integration settings (plan Task 3). Secrets come back masked as
// {set,last4}; a PUT omits a secret to keep the stored one.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiConfigInput, MaskedAiConfig } from '@exam/shared';
import { apiFetch } from '@/lib/api';
import type { MaskedSecret } from '@/lib/integrationsForm';

export interface MaskedSmsConfig {
  enabled: boolean;
  baseUrl: string;
  authToken: MaskedSecret;
  userName: string;
  apiKey: MaskedSecret;
  otpTemplate: string;
}

export interface MaskedEmailConfig {
  enabled: boolean;
  baseUrl: string;
  sendMailToken: MaskedSecret;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  ccAddresses: string;
}

export interface IntegrationsResponse {
  sms: MaskedSmsConfig;
  email: MaskedEmailConfig;
  ai: MaskedAiConfig;
  candidatesWithoutMobile: number;
}

export type Channel = 'sms' | 'email';

export function useIntegrations() {
  return useQuery({
    queryKey: ['admin', 'integrations'],
    queryFn: () => apiFetch<IntegrationsResponse>('admin', '/integrations'),
  });
}

export function useSaveIntegration(channel: Channel) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string | boolean>) =>
      apiFetch<unknown>('admin', `/integrations/${channel}`, { method: 'PUT', json: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'integrations'] }),
  });
}

/** SMS takes {mobile}, email takes {email}. A provider failure arrives as a 502 ApiError. */
export function useSendTest(channel: Channel) {
  return useMutation({
    mutationFn: (target: string) =>
      apiFetch<{ delivered: true }>('admin', `/integrations/${channel}/test`, {
        method: 'POST',
        json: channel === 'sms' ? { mobile: target } : { email: target },
      }),
  });
}

/** apiKey: omitted keeps the stored key, '' clears it. */
export function useSaveAiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AiConfigInput) => apiFetch<unknown>('admin', '/integrations/ai', { method: 'PUT', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'integrations'] }),
  });
}

/** One tiny model call with the saved settings; a provider failure arrives as an ApiError. */
export function useTestAi() {
  return useMutation({ mutationFn: () => apiFetch<unknown>('admin', '/integrations/ai/test', { method: 'POST', json: {} }) });
}
