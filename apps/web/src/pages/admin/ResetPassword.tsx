// src/pages/admin/ResetPassword.tsx
// Why: self-service admin password reset, step 2. The one-time token arrives in
// the URL fragment; it is read once, then stripped from the address bar so it
// is not left in history. A fragment-only change in the same tab does not
// remount the page, so the token is re-read on hashchange.

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { AuthPageShell, ServerErrorNotice } from '@/components/auth/AuthPageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminResetPassword } from '@/api/admin/auth';
import { ApiError } from '@/lib/api';
import { readResetToken } from '@/lib/resetToken';
import { loginErrorMessage } from '@/pages/admin/Login';

const schema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters').max(72, 'Password must be at most 72 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });
type Values = z.infer<typeof schema>;

const INVALID = 'This reset link is invalid or has expired.';

export default function ResetPassword() {
  const [token, setToken] = useState<string | null>(() => readResetToken(window.location.hash));
  const reset = useAdminResetPassword();
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema) });

  useEffect(() => {
    const onHash = () => {
      const t = readResetToken(window.location.hash);
      if (t) {
        setToken(t);
        reset.reset();
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // Mount-only: reset.reset is stable for the mutation's lifetime.
  }, []);

  // Strip the token from the address bar once it is in state.
  useEffect(() => {
    if (token && window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [token]);

  const shell = (title: string, children: React.ReactNode) => (
    <AuthPageShell title={title} subtitle="Arihant Plus — Recruitment Assessment" brand="plus" aside={<ArihantPlusBanner />}>
      {children}
    </AuthPageShell>
  );

  const linkDead = !token || (reset.error instanceof ApiError && reset.error.code === 'RESET_LINK_INVALID');
  if (linkDead) {
    return shell(
      'Link not valid',
      <div className="space-y-4">
        <ServerErrorNotice message={INVALID} />
        <Link to="/admin/forgot-password" className="text-sm text-primary hover:underline">
          Request a new link
        </Link>
      </div>,
    );
  }

  if (reset.isSuccess) {
    return shell(
      'Password changed',
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground" role="status">
          Password changed. Sign in with your new password.
        </p>
        <Button asChild className="w-full">
          <Link to="/admin/login">Go to sign in</Link>
        </Button>
      </div>,
    );
  }

  return shell(
    'Choose a new password',
    <form className="space-y-4" onSubmit={handleSubmit((v) => reset.mutate({ token, password: v.password }))} noValidate>
      {reset.isError && <ServerErrorNotice message={loginErrorMessage(reset.error)} />}
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" type="password" autoComplete="new-password" error={errors.password?.message} {...register('password')} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register('confirm')} />
      </div>
      <Button type="submit" className="w-full" disabled={reset.isPending}>
        {reset.isPending ? 'Saving…' : 'Save new password'}
      </Button>
    </form>,
  );
}
