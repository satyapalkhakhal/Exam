// src/api/candidate/auth.ts
// Why: the candidate sign-in calls (plan Task 6). request-otp is always 200 {sent:true}
// (anti-enumeration) except 429 OTP_COOLDOWN; verify-otp sets the cookies and returns the profile.

import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { CandidateSelf } from '@/types/auth';

export function useRequestOtp() {
  return useMutation({
    mutationFn: (body: { identifier: string }) =>
      apiFetch<{ sent: true }>('candidate', '/auth/request-otp', { method: 'POST', json: body, noRedirect: true }),
  });
}

export function useCandidateVerifyOtp() {
  return useMutation({
    mutationFn: (body: { identifier: string; code: string }) =>
      apiFetch<{ candidate: CandidateSelf }>('candidate', '/auth/verify-otp', {
        method: 'POST',
        json: body,
        noRedirect: true,
      }),
  });
}
