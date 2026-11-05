// src/pages/admin/Login.tsx
// Why: admin sign-in is email + password, then a one-time code (plan Task 5). The
// password step returns a challengeId that the OTP step trades for the session.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, useNavigate } from 'react-router';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { AuthPageShell, ServerErrorNotice } from '@/components/auth/AuthPageShell';
import { OtpForm } from '@/components/auth/OtpForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminLogin, useAdminVerifyOtp } from '@/api/admin/auth';
import { ApiError } from '@/lib/api';
import { useAdminAuth } from '@/stores/adminAuth';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
type Values = z.infer<typeof schema>;

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'ACCOUNT_LOCKED') return 'Too many attempts — try again in 15 minutes';
    if (err.code === 'RATE_LIMITED') return 'Too many requests. Please wait a moment and try again.';
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export default function Login() {
  const navigate = useNavigate();
  const admin = useAdminAuth((s) => s.admin);
  const setAdmin = useAdminAuth((s) => s.setAdmin);
  const login = useAdminLogin();
  const verify = useAdminVerifyOtp();
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [creds, setCreds] = useState<Values | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema) });

  if (admin) return <Navigate to="/admin" replace />;

  const submitCreds = (values: Values) =>
    login.mutate(values, {
      onSuccess: (r) => {
        setCreds(values);
        setOtpError(null);
        setChallengeId(r.challengeId);
      },
    });

  const submitCode = (code: string) => {
    if (!challengeId) return;
    setOtpError(null);
    verify.mutate(
      { challengeId, code },
      {
        onSuccess: ({ admin: a }) => {
          setAdmin(a);
          navigate('/admin', { replace: true });
        },
        onError: (e) => setOtpError(loginErrorMessage(e)),
      },
    );
  };

  // A fresh challenge (and code) is issued by repeating the password step.
  const resend = () => {
    if (!creds) return;
    login.mutate(creds, {
      onSuccess: (r) => setChallengeId(r.challengeId),
      onError: (e) => setOtpError(loginErrorMessage(e)),
    });
  };

  if (challengeId) {
    return (
      <AuthPageShell title="Enter your code" subtitle="We sent a 6-digit code to your registered contact." brand="plus" aside={<ArihantPlusBanner />}>
        <OtpForm onSubmit={submitCode} onResend={resend} submitting={verify.isPending} error={otpError} />
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell title="Admin sign in" subtitle="Arihant Plus — Recruitment Assessment" brand="plus" aside={<ArihantPlusBanner />}>
      <form className="space-y-4" onSubmit={handleSubmit(submitCreds)} noValidate>
        {login.isError && <ServerErrorNotice message={loginErrorMessage(login.error)} />}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" error={errors.email?.message} {...register('email')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        </div>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Continue'}
        </Button>
      </form>
    </AuthPageShell>
  );
}
