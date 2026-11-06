// src/pages/admin/Integrations.tsx
// Why: Super Admin enters SMS / email credentials (design §10). Secrets are shown
// as "•••• 1234 (saved)" with a Replace button, and an empty value keeps the saved
// one (buildIntegrationPatch). Each card has a Send test dialog.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertTriangle } from 'lucide-react';
import { AI_CONCURRENCY_MAX, type AiConfigInput, type MaskedAiConfig } from '@exam/shared';
import { MAX_EMAIL_CC, invalidEmailInList, parseEmailList } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  useIntegrations, useSaveAiConfig, useSaveIntegration, useSendTest, useTestAi,
  type Channel, type MaskedEmailConfig, type MaskedSmsConfig,
} from '@/api/admin/integrations';
import { buildIntegrationPatch, maskedLabel, type MaskedSecret } from '@/lib/integrationsForm';

const optEmail = z.string().refine((v) => v.trim() === '' || z.string().email().safeParse(v.trim()).success, 'Enter a valid email');
const url = z.string().trim().url('Enter a valid URL');

const smsSchema = z.object({
  enabled: z.boolean(), baseUrl: url, userName: z.string(), authToken: z.string(), apiKey: z.string(),
  otpTemplate: z.string().refine((v) => v.includes('{otp}'), 'Template must contain {otp}'),
});
const ccList = z.string().superRefine((v, ctx) => {
  const bad = invalidEmailInList(v);
  if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Not a valid email: ${bad}` });
  else if (parseEmailList(v).length > MAX_EMAIL_CC) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `At most ${MAX_EMAIL_CC} addresses` });
});
const emailSchema = z.object({
  enabled: z.boolean(), baseUrl: url, sendMailToken: z.string(),
  fromAddress: optEmail, fromName: z.string(), replyTo: optEmail, ccAddresses: ccList,
});

function SecretField({ id, label, saved, value, onChange }: {
  id: string; label: string; saved: MaskedSecret; value: string; onChange: (v: string) => void;
}) {
  const [replacing, setReplacing] = useState(!saved.set);
  const text = maskedLabel(saved);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {replacing ? (
        <div className="flex gap-2">
          <Input id={id} type="password" autoComplete="off" placeholder={saved.set ? 'Enter new value' : ''} value={value} onChange={(e) => onChange(e.target.value)} />
          {saved.set && (
            <Button type="button" variant="outline" onClick={() => { onChange(''); setReplacing(false); }}>Cancel</Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span id={id} className="flex h-10 flex-1 items-center rounded-lg border border-input bg-muted/30 px-3 text-sm text-muted-foreground">{text}</span>
          <Button type="button" variant="outline" onClick={() => setReplacing(true)}>Replace</Button>
        </div>
      )}
    </div>
  );
}

function TestDialog({ channel, open, onClose }: { channel: Channel; open: boolean; onClose: () => void }) {
  const test = useSendTest(channel);
  const [target, setTarget] = useState('');
  const isSms = channel === 'sms';
  const close = () => { setTarget(''); test.reset(); onClose(); };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send test {isSms ? 'SMS' : 'email'}</DialogTitle>
          <DialogDescription>Uses the saved settings, so save any changes first.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (target.trim()) test.mutate(target.trim()); }}>
          <Label htmlFor={`${channel}-test`}>{isSms ? 'Mobile number' : 'Email address'}</Label>
          <Input id={`${channel}-test`} type={isSms ? 'tel' : 'email'} value={target} onChange={(e) => setTarget(e.target.value)} />
          <div aria-live="polite">
            {test.isSuccess && <p className="text-sm text-green-600">Delivered. Check the {isSms ? 'phone' : 'inbox'}.</p>}
            {test.isError && <p role="alert" className="text-sm text-destructive">{test.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Close</Button>
            <Button type="submit" disabled={test.isPending || !target.trim()}>{test.isPending ? 'Sending…' : 'Send test'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SaveBar({ pending, error, saved }: { pending: boolean; error: string | null; saved: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</Button>
      <div aria-live="polite" className="text-sm">
        {error && <span role="alert" className="text-destructive">{error}</span>}
        {saved && !error && <span className="text-green-600">Saved</span>}
      </div>
    </div>
  );
}

// The test dialog is rendered by the caller, outside the card <form>: React submit
// events bubble through the Radix portal, so a nested form would also save the config.
function CardShell({ title, channel, enabled, onEnabled, onTest, children }: {
  title: string; channel: Channel; enabled: boolean; onEnabled: (v: boolean) => void; onTest: () => void; children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor={`${channel}-enabled`}>Enabled</Label>
            <Switch id={`${channel}-enabled`} checked={enabled} onCheckedChange={onEnabled} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {children}
        <Button type="button" variant="outline" onClick={onTest}>Send test…</Button>
      </CardContent>
    </Card>
  );
}

function SmsCard({ saved }: { saved: MaskedSmsConfig }) {
  const save = useSaveIntegration('sms');
  const [testing, setTesting] = useState(false);
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<z.infer<typeof smsSchema>>({
    resolver: zodResolver(smsSchema),
    defaultValues: { enabled: saved.enabled, baseUrl: saved.baseUrl, userName: saved.userName, authToken: '', apiKey: '', otpTemplate: saved.otpTemplate },
  });
  return (
    <>
    <form noValidate onSubmit={handleSubmit((v) => save.mutate(buildIntegrationPatch(v, { ...saved })))}>
      <CardShell title="SMS (Arihant gateway)" channel="sms" onTest={() => setTesting(true)} enabled={watch('enabled')} onEnabled={(v) => setValue('enabled', v, { shouldDirty: true })}>
        <div className="space-y-1.5">
          <Label htmlFor="sms-baseUrl">Base URL</Label>
          <Input id="sms-baseUrl" error={errors.baseUrl?.message} {...register('baseUrl')} />
        </div>
        <SecretField id="sms-authToken" label="Auth token" saved={saved.authToken} value={watch('authToken')} onChange={(v) => setValue('authToken', v)} />
        <div className="space-y-1.5">
          <Label htmlFor="sms-userName">User name</Label>
          <Input id="sms-userName" {...register('userName')} />
        </div>
        <SecretField id="sms-apiKey" label="API key" saved={saved.apiKey} value={watch('apiKey')} onChange={(v) => setValue('apiKey', v)} />
        <div className="space-y-1.5">
          <Label htmlFor="sms-otpTemplate">OTP message template</Label>
          <Textarea id="sms-otpTemplate" rows={3} {...register('otpTemplate')} />
          <p className="text-xs text-muted-foreground">Use {'{otp}'} where the code goes. It must match the DLT-approved template.</p>
          {errors.otpTemplate && <p className="text-xs text-destructive">{errors.otpTemplate.message}</p>}
        </div>
        <SaveBar pending={save.isPending} error={save.isError ? save.error.message : null} saved={save.isSuccess} />
      </CardShell>
    </form>
    <TestDialog channel="sms" open={testing} onClose={() => setTesting(false)} />
    </>
  );
}

function EmailCard({ saved }: { saved: MaskedEmailConfig }) {
  const save = useSaveIntegration('email');
  const [testing, setTesting] = useState(false);
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: {
      enabled: saved.enabled, baseUrl: saved.baseUrl, sendMailToken: '', fromAddress: saved.fromAddress,
      fromName: saved.fromName, replyTo: saved.replyTo, ccAddresses: saved.ccAddresses ?? '',
    },
  });
  const ccCount = parseEmailList(watch('ccAddresses') ?? '').length;
  return (
    <>
    <form noValidate onSubmit={handleSubmit((v) => save.mutate(buildIntegrationPatch(v, { ...saved })))}>
      <CardShell title="Email (ZatpatMail)" channel="email" onTest={() => setTesting(true)} enabled={watch('enabled')} onEnabled={(v) => setValue('enabled', v, { shouldDirty: true })}>
        <div className="space-y-1.5">
          <Label htmlFor="email-baseUrl">Base URL</Label>
          <Input id="email-baseUrl" error={errors.baseUrl?.message} {...register('baseUrl')} />
        </div>
        <SecretField id="email-token" label="Send-mail token" saved={saved.sendMailToken} value={watch('sendMailToken')} onChange={(v) => setValue('sendMailToken', v)} />
        <div className="space-y-1.5">
          <Label htmlFor="email-fromAddress">From address</Label>
          <Input id="email-fromAddress" type="email" error={errors.fromAddress?.message} {...register('fromAddress')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email-fromName">From name</Label>
          <Input id="email-fromName" {...register('fromName')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email-replyTo">Reply-to</Label>
          <Input id="email-replyTo" type="email" error={errors.replyTo?.message} {...register('replyTo')} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email-cc">CC on result emails</Label>
          <Textarea
            id="email-cc"
            rows={2}
            placeholder="talent@arihantcapital.com, hr.lead@arihantcapital.com"
            aria-describedby="email-cc-help"
            {...register('ccAddresses')}
          />
          <p id="email-cc-help" className="text-xs text-muted-foreground">
            Comma-separated, up to {MAX_EMAIL_CC}. Every Shortlisted and Rejected email is copied to these addresses, and candidates can see them.
            {ccCount > 0 && ` ${ccCount} address${ccCount === 1 ? '' : 'es'}.`}
          </p>
          {errors.ccAddresses && <p className="text-xs text-destructive">{errors.ccAddresses.message}</p>}
        </div>
        <SaveBar pending={save.isPending} error={save.isError ? save.error.message : null} saved={save.isSuccess} />
      </CardShell>
    </form>
    <TestDialog channel="email" open={testing} onClose={() => setTesting(false)} />
    </>
  );
}

const aiSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string(),
  model: z.string().trim().min(1, 'Enter the model id').max(100, 'At most 100 characters'),
  concurrency: z.number({ invalid_type_error: 'Enter 1 to ' + AI_CONCURRENCY_MAX }).int('Whole number').min(1, 'At least 1').max(AI_CONCURRENCY_MAX, `At most ${AI_CONCURRENCY_MAX}`),
  gradingInstructions: z.string().max(4000, 'At most 4,000 characters'),
});

function AiCard({ saved }: { saved: MaskedAiConfig }) {
  const save = useSaveAiConfig();
  const test = useTestAi();
  const [clearKey, setClearKey] = useState(false);
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<z.infer<typeof aiSchema>>({
    resolver: zodResolver(aiSchema),
    defaultValues: { enabled: saved.enabled, apiKey: '', model: saved.model, concurrency: saved.concurrency, gradingInstructions: saved.gradingInstructions },
  });
  const typedKey = watch('apiKey').trim();
  const onSubmit = handleSubmit((v) => {
    // Blank keeps the stored key; '' is the explicit clear.
    const apiKey = clearKey ? '' : typedKey !== '' ? typedKey : undefined;
    const body: AiConfigInput = { enabled: v.enabled, model: v.model, concurrency: v.concurrency, gradingInstructions: v.gradingInstructions, ...(apiKey !== undefined ? { apiKey } : {}) };
    save.mutate(body, { onSuccess: () => setClearKey(false) });
  });
  return (
    <form noValidate onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>AI evaluation (OpenAI)</CardTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="ai-enabled">Enabled</Label>
              <Switch id="ai-enabled" checked={watch('enabled')} onCheckedChange={(v) => setValue('enabled', v, { shouldDirty: true })} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Candidate answers (no names or academics) are sent to OpenAI to suggest marks. A person always confirms the marks.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="ai-apiKey">API key</Label>
            {saved.apiKey.set && !clearKey && (
              <p className="text-xs text-muted-foreground">Saved: {maskedLabel(saved.apiKey)}. Leave blank to keep it, or type a new key to replace it.</p>
            )}
            {clearKey ? (
              <div className="flex items-center gap-2">
                <span className="flex h-10 flex-1 items-center rounded-lg border border-input bg-muted/30 px-3 text-sm text-muted-foreground">The saved key will be removed on Save</span>
                <Button type="button" variant="outline" onClick={() => setClearKey(false)}>Undo</Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Input id="ai-apiKey" type="password" autoComplete="off" placeholder={saved.apiKey.set ? 'Enter new key' : 'sk-…'} {...register('apiKey')} />
                {saved.apiKey.set && <Button type="button" variant="outline" onClick={() => { setValue('apiKey', ''); setClearKey(true); }}>Clear key</Button>}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-model">Model</Label>
            <Input id="ai-model" autoComplete="off" aria-describedby="ai-model-help" error={errors.model?.message} {...register('model')} />
            <p id="ai-model-help" className="text-xs text-muted-foreground">The OpenAI model id to use.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-concurrency">Concurrency (1 to {AI_CONCURRENCY_MAX})</Label>
            <Input id="ai-concurrency" type="number" min={1} max={AI_CONCURRENCY_MAX} className="w-28" error={errors.concurrency?.message} {...register('concurrency', { valueAsNumber: true })} />
            <p className="text-xs text-muted-foreground">How many answers are graded at the same time. Lower it if OpenAI rate-limits you.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ai-instructions">Grading instructions</Label>
            <Textarea id="ai-instructions" rows={4} placeholder="Optional extra instructions added to every grading request" {...register('gradingInstructions')} />
            {errors.gradingInstructions && <p className="text-xs text-destructive">{errors.gradingInstructions.message}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</Button>
            <div aria-live="polite" className="text-sm">
              {save.isError && <span role="alert" className="text-destructive">{save.error.message}</span>}
              {save.isSuccess && !save.isError && <span className="text-green-600">Saved. </span>}
              {test.isError && <span role="alert" className="text-destructive">{test.error.message}</span>}
              {test.isSuccess && <span className="text-green-600">Connection works (uses the saved settings).</span>}
            </div>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

export default function Integrations() {
  const { data, isPending, error } = useIntegrations();
  const smsOnlyRisk = data && data.sms.enabled && !data.email.enabled && data.candidatesWithoutMobile > 0;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Integrations</h1>
      {isPending && <p className="text-sm text-muted-foreground" role="status">Loading…</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {smsOnlyRisk && (
        <div role="alert" className="flex gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <p>
            SMS is enabled but email is disabled, and {data.candidatesWithoutMobile} candidate
            {data.candidatesWithoutMobile === 1 ? ' has' : 's have'} no mobile number. They will not receive a code.
            Enable email or add their mobile numbers.
          </p>
        </div>
      )}
      <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Before the live exam, set <code className="font-mono">ALLOW_STATIC_OTP=false</code> on the server so the test code stops working.
      </p>
      {data && (
        <div className="grid gap-4 xl:grid-cols-2">
          <SmsCard saved={data.sms} />
          <EmailCard saved={data.email} />
          <AiCard saved={data.ai} />
        </div>
      )}
    </div>
  );
}
