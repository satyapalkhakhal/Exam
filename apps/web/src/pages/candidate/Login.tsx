// src/pages/candidate/Login.tsx
// Why: candidates sign in with their registered email or 10-digit mobile, then a 6-digit
// code (design 7.1). The reply to "send code" is deliberately the same for unknown people.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useNavigate } from 'react-router';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { AuthPageShell, ServerErrorNotice } from '@/components/auth/AuthPageShell';
import { CandidateNavBar } from '@/components/layout/CandidateNavBar';
import { OtpForm } from '@/components/auth/OtpForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCandidateVerifyOtp, useRequestOtp } from '@/api/candidate/auth';
import { ApiError } from '@/lib/api';
import { useCandidateAuth } from '@/stores/candidateAuth';

const schema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Enter your email or mobile number')
    .refine((v) => /^\d{10}$/.test(v) || z.string().email().safeParse(v).success, 'Enter a valid email or 10-digit mobile number'),
});
type Values = z.infer<typeof schema>;

function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'OTP_COOLDOWN') return 'Please wait a minute before requesting another code.';
    if (err.code === 'RATE_LIMITED') return 'Too many requests. Please wait a moment and try again.';
    if (err.code === 'OTP_INVALID') return 'That code is not valid. Check it and try again.';
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export default function CandidateLogin() {
  const navigate = useNavigate();
  const candidate = useCandidateAuth((s) => s.candidate);
  const setCandidate = useCandidateAuth((s) => s.setCandidate);
  const request = useRequestOtp();
  const verify = useCandidateVerifyOtp();
  const [identifier, setIdentifier] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  // Set before the store so the already-signed-in redirect below doesn't beat the /location hop.
  const [verified, setVerified] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema) });

  if (candidate && !verified) return <Navigate to="/dashboard" replace />;

  const submitId = (v: Values) =>
    request.mutate({ identifier: v.identifier }, { onSuccess: () => { setOtpError(null); setIdentifier(v.identifier); } });

  const submitCode = (code: string) => {
    if (!identifier) return;
    setOtpError(null);
    verify.mutate(
      { identifier, code },
      {
        onSuccess: ({ candidate: c }) => {
          setVerified(true);
          setCandidate(c);
          navigate('/location', { replace: true });
        },
        onError: (e) => setOtpError(message(e)),
      },
    );
  };

  const resend = () => {
    if (!identifier) return;
    request.mutate({ identifier }, { onError: (e) => setOtpError(message(e)) });
  };

  if (identifier) {
    return (
      <AuthPageShell nav={<CandidateNavBar />} title="Enter your code" subtitle="If you're registered, a code has been sent." brand="plus" aside={<ArihantPlusBanner />}>
        <OtpForm onSubmit={submitCode} onResend={resend} submitting={verify.isPending} error={otpError} />
        {/* The response is the same whether or not a code went out (no account probing), so
            a delivery failure reaches the candidate only through this line; HR sees it in the log. */}
        <p className="mt-4 text-center text-sm text-muted-foreground">Didn&apos;t get a code within 2 minutes? Contact HR.</p>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell nav={<CandidateNavBar />} title="Candidate sign in" subtitle="Arihant Plus — Recruitment Assessment" brand="plus" aside={<ArihantPlusBanner />}>
      <form className="space-y-4" onSubmit={handleSubmit(submitId)} noValidate>
        {request.isError && <ServerErrorNotice message={message(request.error)} />}
        <div className="space-y-1.5">
          <Label htmlFor="identifier">Email or mobile number</Label>
          <Input id="identifier" autoComplete="username" inputMode="email" error={errors.identifier?.message} {...register('identifier')} />
        </div>
        <Button type="submit" className="w-full" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Send code'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        First time? <Link to="/register" className="text-primary hover:underline">Register your mobile number</Link>
      </p>
    </AuthPageShell>
  );
}
