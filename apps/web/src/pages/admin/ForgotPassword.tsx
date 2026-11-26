// src/pages/admin/ForgotPassword.tsx
// Why: self-service admin password reset, step 1. The API always answers the
// same way, so this page never says whether the email belongs to an account.

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { AuthPageShell, ServerErrorNotice } from '@/components/auth/AuthPageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminForgotPassword } from '@/api/admin/auth';
import { loginErrorMessage } from '@/pages/admin/Login';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email').email('Enter a valid email'),
});
type Values = z.infer<typeof schema>;

export default function ForgotPassword() {
  const request = useAdminForgotPassword();
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema) });

  const back = (
    <Link to="/admin/login" className="text-sm text-primary hover:underline">
      Back to sign in
    </Link>
  );

  if (request.isSuccess) {
    return (
      <AuthPageShell title="Check your email" subtitle="Arihant Plus — Recruitment Assessment" brand="plus" aside={<ArihantPlusBanner />}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground" role="status">
            If an active admin account uses that email, a reset link is on its way. It expires in 30 minutes.
          </p>
          {back}
        </div>
      </AuthPageShell>
    );
  }

  return (
    <AuthPageShell title="Forgot password" subtitle="We'll email you a link to choose a new one." brand="plus" aside={<ArihantPlusBanner />}>
      <form className="space-y-4" onSubmit={handleSubmit((v) => request.mutate(v))} noValidate>
        {request.isError && <ServerErrorNotice message={loginErrorMessage(request.error)} />}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" error={errors.email?.message} {...register('email')} />
        </div>
        <Button type="submit" className="w-full" disabled={request.isPending}>
          {request.isPending ? 'Sending…' : 'Send reset link'}
        </Button>
        <div className="text-center">{back}</div>
      </form>
    </AuthPageShell>
  );
}
