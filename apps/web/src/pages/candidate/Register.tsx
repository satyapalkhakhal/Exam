// src/pages/candidate/Register.tsx
// Why: candidates imported without a mobile register one on first sign-in. Email + roll
// number identify them, an SMS code proves the phone, and verifying links the mobile and
// signs them in. The send step replies the same whether or not the details matched (no
// account probing), so a mismatch only shows up as "no code arrived".

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useNavigate } from 'react-router';
import { normalizeMobile } from '@exam/shared';
import { AuthPageShell, ServerErrorNotice } from '@/components/auth/AuthPageShell';
import { OtpForm } from '@/components/auth/OtpForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRequestMobileLink, useVerifyMobileLink, type MobileLinkBody } from '@/api/candidate/auth';
import { ApiError } from '@/lib/api';
import { useCandidateAuth } from '@/stores/candidateAuth';

const schema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Enter your email').email('Enter a valid email'),
  rollNumber: z.string().trim().min(1, 'Enter your roll number').max(200),
  mobile: z
    .string()
    .trim()
    .refine((v) => normalizeMobile(v) !== null, 'Enter a 10-digit Indian mobile number')
    .transform((v) => normalizeMobile(v) ?? v),
});
type FormIn = z.input<typeof schema>;

function message(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'OTP_COOLDOWN') return 'Please wait a minute before requesting another code.';
    if (err.code === 'RATE_LIMITED') return 'Too many requests. Please wait a moment and try again.';
    if (err.code === 'OTP_INVALID') return 'That code is not valid. Check it and try again.';
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export default function CandidateRegister() {
  const navigate = useNavigate();
  const candidate = useCandidateAuth((s) => s.candidate);
  const setCandidate = useCandidateAuth((s) => s.setCandidate);
  const request = useRequestMobileLink();
  const verify = useVerifyMobileLink();
  const [details, setDetails] = useState<MobileLinkBody | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  // Set before the store so the already-signed-in redirect below doesn't beat the /location hop.
  const [verified, setVerified] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<FormIn, unknown, MobileLinkBody>({
    resolver: zodResolver(schema),
  });

  if (candidate && !verified) return <Navigate to="/dashboard" replace />;

  const submitDetails = (v: MobileLinkBody) =>
    request.mutate(v, { onSuccess: () => { setOtpError(null); setDetails(v); } });

  const submitCode = (code: string) => {
    if (!details) return;
    setOtpError(null);
    verify.mutate(
      { ...details, code },
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
    if (!details) return;
    request.mutate(details, { onError: (e) => setOtpError(message(e)) });
  };

  if (details) {
    const masked = `${details.mobile.slice(0, 2)}******${details.mobile.slice(-2)}`;
    return (
      <AuthPageShell title="Verify your mobile" subtitle={`If your details match, a code has been sent by SMS to ${masked}.`}>
        <OtpForm onSubmit={submitCode} onResend={resend} submitting={verify.isPending} error={otpError} />
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No SMS within 2 minutes? Check your email and roll number, or contact HR.
        </p>
        <p className="mt-2 text-center text-sm">
          <button type="button" className="text-primary hover:underline" onClick={() => { setDetails(null); setOtpError(null); }}>
            Change details
          </button>
        </p>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell title="Register your mobile" subtitle="First time here? Link your mobile number to sign in.">
      <form className="space-y-4" onSubmit={handleSubmit(submitDetails)} noValidate>
        {request.isError && <ServerErrorNotice message={message(request.error)} />}
        <div className="space-y-1.5">
          <Label htmlFor="email">Registered email</Label>
          <Input id="email" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rollNumber">Roll number</Label>
          <Input id="rollNumber" autoComplete="off" error={errors.rollNumber?.message} {...register('rollNumber')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mobile">Mobile number</Label>
          <Input id="mobile" type="tel" inputMode="tel" autoComplete="tel-national" error={errors.mobile?.message} {...register('mobile')} />
          <p className="text-xs text-muted-foreground">We&apos;ll send a code to this number. It can be linked only once.</p>
        </div>
        <Button type="submit" className="w-full" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Send code'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Already registered? <Link to="/login" className="text-primary hover:underline">Sign in</Link>
      </p>
    </AuthPageShell>
  );
}
