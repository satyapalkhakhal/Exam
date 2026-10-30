// src/api/admin/auth.ts
// Why: the admin sign-in calls (plan Task 5). Login returns a challenge, the OTP
// step trades it for the session cookies and the admin profile.

import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { AdminSelf } from '@/types/auth';

export interface LoginResult {
  otpRequired: true;
  challengeId: string;
}

export function useAdminLogin() {
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      apiFetch<LoginResult>('admin', '/auth/login', { method: 'POST', json: body, noRedirect: true }),
  });
}

export function useAdminVerifyOtp() {
  return useMutation({
    mutationFn: (body: { challengeId: string; code: string }) =>
      apiFetch<{ admin: AdminSelf }>('admin', '/auth/verify-otp', { method: 'POST', json: body, noRedirect: true }),
  });
}
