// src/pages/admin/CandidateDetail.tsx
// Why: Super Admin's per-candidate view (design §6.2, §7.2a): editable profile, login and
// start locations, activity, integrity/location flags and status history, plus the
// eligibility, location-exempt and reset-attempt actions. Location is approximate and
// spoofable, so the disclaimer is always shown next to it.

import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SendEmailDialog } from '@/components/admin/SendEmailDialog';
import { EmailDispatchTable } from '@/components/admin/EmailDispatchTable';
import { useRoles } from '@/api/admin/roles';
import {
  useCandidate,
  useEditCandidate,
  useResetAttempt,
  useSetEligibility,
  useSetLocationExempt,
  type CandidateDetailProfile,
  type CandidateEdit,
  type IntegrityCounts,
} from '@/api/admin/candidates';
import { formatIst } from '@/lib/istTime';
import { statusText } from './Candidates';

/** Activity metadata is arbitrary JSON; never hand an object to React as a child. */
function DetailCell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <>-</>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return <>{String(value)}</>;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return (
      <dl className="space-y-0.5 text-xs">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="flex gap-1"><dt className="text-muted-foreground">{k}:</dt><dd className="break-all">{typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}</dd></div>
        ))}
      </dl>
    );
  }
  return <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(value)}</pre>;
}

const INTEGRITY_LABELS: [keyof IntegrityCounts, string][] = [
  ['pasteAttempts', 'Paste / copy / cut / drop attempts'],
  ['bulkInsert', 'Suspicious bulk inserts'],
  ['tabHidden', 'Tab switches'],
  ['blur', 'Window blur (informational)'],
  ['ipChanges', 'IP changes during exam'],
];

const optNum = (min: number, max: number, label: string) =>
  z.string().trim().refine((v) => v === '' || (!Number.isNaN(Number(v)) && Number(v) >= min && Number(v) <= max), `${label} must be ${min} to ${max}`);

const profileSchema = z.object({
  fullName: z.string().trim().min(2, 'At least 2 characters').max(150),
  email: z.string().trim().email('Enter a valid email'),
  mobile: z.string().trim().refine((v) => v === '' || /^(\+?91|0)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, '')), 'Enter a 10-digit mobile'),
  rollNumber: z.string().trim(),
  xPercentage: optNum(0, 100, 'X %'),
  xiiPercentage: optNum(0, 100, 'XII %'),
  majorCpi: optNum(0, 10, 'CPI'),
  discipline: z.string().trim(),
  programme: z.string().trim(),
  jobRoleId: z.string().min(1),
});
type PValues = z.infer<typeof profileSchema>;

const num = (v: string) => (v === '' ? null : Number(v));
const txt = (v: string) => (v === '' ? null : v);

function ProfileForm({ c }: { c: CandidateDetailProfile }) {
  const roles = useRoles();
  const edit = useEditCandidate(c.id);
  const [saved, setSaved] = useState(false);
  const { register, handleSubmit, formState: { errors, isDirty } } = useForm<PValues>({
    resolver: zodResolver(profileSchema),
    values: {
      fullName: c.fullName,
      email: c.email,
      mobile: c.mobile ?? '',
      rollNumber: c.rollNumber ?? '',
      xPercentage: c.xPercentage?.toString() ?? '',
      xiiPercentage: c.xiiPercentage?.toString() ?? '',
      majorCpi: c.majorCpi?.toString() ?? '',
      discipline: c.discipline ?? '',
      programme: c.programme ?? '',
      jobRoleId: c.jobRoleId,
    },
  });
  const roleLocked = c.status !== 'NOT_STARTED';
  const field = (id: keyof PValues, label: string, type = 'text') => (
    <div className="space-y-1.5">
      <Label htmlFor={`cd-${id}`}>{label}</Label>
      <Input id={`cd-${id}`} type={type} step={type === 'number' ? 'any' : undefined} error={errors[id]?.message} {...register(id)} />
    </div>
  );
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit((v) => {
        setSaved(false);
        const body: CandidateEdit = {
          fullName: v.fullName,
          email: v.email.toLowerCase(),
          mobile: txt(v.mobile),
          rollNumber: txt(v.rollNumber),
          xPercentage: num(v.xPercentage),
          xiiPercentage: num(v.xiiPercentage),
          majorCpi: num(v.majorCpi),
          discipline: txt(v.discipline),
          programme: txt(v.programme),
          // Only sent when it changed: the server rejects any role change after the exam started.
          ...(v.jobRoleId !== c.jobRoleId ? { jobRoleId: v.jobRoleId } : {}),
        };
        edit.mutate(body, { onSuccess: () => setSaved(true) });
      })}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field('fullName', 'Name')}
        {field('email', 'Email', 'email')}
        {field('mobile', 'Mobile')}
        {field('rollNumber', 'Roll number')}
        {field('xPercentage', 'X percentage', 'number')}
        {field('xiiPercentage', 'XII percentage', 'number')}
        {field('majorCpi', 'Major CPI', 'number')}
        {field('discipline', 'Discipline')}
        {field('programme', 'Programme')}
        <div className="space-y-1.5">
          <Label htmlFor="cd-jobRoleId">Job role</Label>
          <Select id="cd-jobRoleId" disabled={roleLocked} {...register('jobRoleId')}>
            {(roles.data ?? [{ id: c.jobRoleId, name: c.jobRoleName }]).map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
          {roleLocked && <p className="text-xs text-muted-foreground">The role can only change before the candidate starts.</p>}
        </div>
      </div>
      {Object.keys(c.extra).length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Other imported columns</h3>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {Object.entries(c.extra).map(([k, v]) => (
              <div key={k} className="flex gap-2"><dt className="text-muted-foreground">{k}:</dt><dd>{String(v ?? '')}</dd></div>
            ))}
          </dl>
        </div>
      )}
      {edit.isError && <p role="alert" className="text-sm text-destructive">{edit.error.message}</p>}
      {saved && !edit.isError && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      <Button type="submit" disabled={edit.isPending || !isDirty}>{edit.isPending ? 'Saving…' : 'Save changes'}</Button>
    </form>
  );
}

const reasonSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason (at least 10 characters)') });

function ReasonDialog({ open, title, description, confirmLabel, error, pending, onClose, onSubmit }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  error: string | undefined;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ reason: string }>({ resolver: zodResolver(reasonSchema), defaultValues: { reason: '' } });
  const close = () => {
    reset();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-3 px-6 pb-2" noValidate onSubmit={handleSubmit((v) => onSubmit(v.reason))}>
          <div className="space-y-1.5">
            <Label htmlFor="rd-reason">Reason</Label>
            <Textarea id="rd-reason" rows={3} error={errors.reason?.message} {...register('reason')} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="-mx-6">
            <Button type="button" variant="outline" onClick={close} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? 'Saving…' : confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export const osmUrl = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;

export default function CandidateDetail() {
  const { id = '' } = useParams();
  const [activityPage, setActivityPage] = useState(1);
  const { data, isPending, error } = useCandidate(id, activityPage);
  const eligibility = useSetEligibility(id);
  const exempt = useSetLocationExempt(id);
  const reset = useResetAttempt(id);
  const [emailOpen, setEmailOpen] = useState(false);
  const [exemptOpen, setExemptOpen] = useState(false);
  const [resetStep, setResetStep] = useState<'closed' | 'reason' | 'confirm'>('closed');
  const [resetReason, setResetReason] = useState('');

  if (isPending) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (error || !data) return <p className="text-sm text-destructive" role="alert">{error?.message ?? 'Candidate not found'}</p>;
  const { candidate: c, loginLogs, activity, flags, history, attempt } = data;
  const otherApplications = data.otherApplications ?? [];
  const integrity = flags?.integrity;
  const locationFlags = flags?.location ?? [];
  const flagTotal = (integrity ? integrity.pasteAttempts + integrity.bulkInsert + integrity.ipChanges : 0) + locationFlags.length;

  return (
    <div className="space-y-4">
      <Link to="/admin/candidates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Candidates
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{c.fullName}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{c.candidateCode}</span> · {c.jobRoleName} · <Badge variant="outline">{statusText(c.status)}</Badge>
            {attempt && <> · attempt {statusText(attempt.status)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={c.eligible} disabled={eligibility.isPending} onCheckedChange={(v) => eligibility.mutate(v)} aria-label="Eligible to take the exam" />
            Eligible
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={c.locationExempt} disabled={exempt.isPending} onCheckedChange={() => setExemptOpen(true)} aria-label="Exempt from location" />
            Location exempt
          </label>
          <Button variant="outline" size="sm" onClick={() => setEmailOpen(true)}>Send email</Button>
          <Button variant="destructive" size="sm" onClick={() => setResetStep('reason')}>Reset attempt</Button>
        </div>
      </div>
      {otherApplications.length > 0 && (
        <section aria-label="Other applications" className="rounded-lg border border-border bg-card p-3 text-sm">
          <h2 className="mb-1 font-medium">Other applications by this person</h2>
          <ul className="space-y-1">
            {otherApplications.map((o) => (
              <li key={o.id}>
                <Link to={`/admin/candidates/${o.id}`} className="text-primary hover:underline">
                  <span className="font-mono">{o.candidateCode}</span> · {o.jobRole.name}
                </Link>{' '}
                <Badge variant="outline">{statusText(o.status)}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(eligibility.error || reset.error) && (
        <p role="alert" className="text-sm text-destructive">{(eligibility.error ?? reset.error)?.message}</p>
      )}

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="location">Login &amp; location</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="flags">Flags ({flagTotal})</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="emails">Emails</TabsTrigger>
        </TabsList>

        <TabsContent value="profile"><ProfileForm c={c} /></TabsContent>

        <TabsContent value="location" className="space-y-3">
          <p className="rounded-md border border-border bg-muted/50 p-3 text-sm">
            Location is approximate. A laptop's position usually comes from Wi-Fi or IP and can be off by 20 m to several km, and it can be faked. Treat it as a signal for review, not proof.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When (IST)</TableHead><TableHead>Type</TableHead><TableHead>Permission</TableHead>
                  <TableHead>Location</TableHead><TableHead>Accuracy</TableHead><TableHead>IP</TableHead><TableHead>Device</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loginLogs.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No logins yet.</TableCell></TableRow>}
                {loginLogs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{formatIst(l.createdAt)}</TableCell>
                    <TableCell>{l.kind === 'START' ? 'Exam start' : 'Login'}</TableCell>
                    <TableCell>{statusText(l.permission)}</TableCell>
                    <TableCell>
                      {l.latitude !== null && l.longitude !== null ? (
                        <a href={osmUrl(l.latitude, l.longitude)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          Open map<span className="sr-only"> (OpenStreetMap, new tab)</span>
                        </a>
                      ) : '-'}
                    </TableCell>
                    <TableCell>{l.accuracyM !== null ? `${Math.round(l.accuracyM)} m` : '-'}</TableCell>
                    <TableCell className="font-mono text-xs">{l.ip ?? '-'}</TableCell>
                    <TableCell>{[l.browser, l.os, l.deviceType].filter(Boolean).join(' · ') || '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="activity" className="space-y-2">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>When (IST)</TableHead><TableHead>Event</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
              <TableBody>
                {activity.items.length === 0 && <TableRow><TableCell colSpan={3} className="text-muted-foreground">No activity yet.</TableCell></TableRow>}
                {activity.items.map((a) => (
                  <TableRow key={a.id}><TableCell>{formatIst(a.createdAt)}</TableCell><TableCell>{statusText(a.type)}</TableCell><TableCell><DetailCell value={a.detail} /></TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={activity.page} pageSize={activity.pageSize} total={activity.total} totalPages={Math.max(1, Math.ceil(activity.total / activity.pageSize))} onPageChange={setActivityPage} />
        </TabsContent>

        <TabsContent value="flags">
          <p className="mb-2 text-sm text-muted-foreground">Flags are for HR review; they never disqualify a candidate automatically.</p>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>Flag</TableHead><TableHead>Count / detail</TableHead></TableRow></TableHeader>
              <TableBody>
                {INTEGRITY_LABELS.map(([k, label]) => (
                  <TableRow key={k}><TableCell>{label}</TableCell><TableCell>{integrity ? integrity[k] : 0}</TableCell></TableRow>
                ))}
                {locationFlags.length === 0 && <TableRow><TableCell>Location flags</TableCell><TableCell className="text-muted-foreground">None</TableCell></TableRow>}
                {locationFlags.map((f, i) => (
                  <TableRow key={`${f.code}-${i}`}><TableCell>{statusText(f.code)}</TableCell><TableCell><DetailCell value={Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'code'))} /></TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="history">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>When (IST)</TableHead><TableHead>Change</TableHead><TableHead>By</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody>
                {history.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">No status changes yet.</TableCell></TableRow>}
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{formatIst(h.createdAt)}</TableCell>
                    <TableCell>{h.fromStatus ? `${statusText(h.fromStatus)} to ${statusText(h.toStatus)}` : statusText(h.toStatus)}</TableCell>
                    <TableCell>{h.actorName ?? 'System'}</TableCell>
                    <TableCell>{h.reason ?? '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="emails"><EmailDispatchTable candidateId={c.id} /></TabsContent>
      </Tabs>

      <SendEmailDialog
        open={emailOpen}
        candidateIds={[c.id]}
        defaultTemplate={c.status === 'SHORTLISTED' ? 'SHORTLISTED' : 'SUBMISSION_RECEIVED'}
        onClose={() => setEmailOpen(false)}
      />
      <ReasonDialog
        open={exemptOpen}
        title={c.locationExempt ? 'Remove location exemption' : 'Exempt from location'}
        description={c.locationExempt ? 'The candidate will need to share location to start.' : 'For genuine cases only, such as a desktop with no location hardware. This is audited.'}
        confirmLabel={c.locationExempt ? 'Remove exemption' : 'Exempt'}
        error={exempt.error?.message}
        pending={exempt.isPending}
        onClose={() => setExemptOpen(false)}
        onSubmit={(reason) => exempt.mutate({ exempt: !c.locationExempt, reason }, { onSuccess: () => setExemptOpen(false) })}
      />
      <ReasonDialog
        open={resetStep === 'reason'}
        title="Reset attempt"
        description="Lets the candidate retake the exam. The old attempt is kept as RESET. This is audited."
        confirmLabel="Continue"
        error={undefined}
        pending={false}
        onClose={() => setResetStep('closed')}
        onSubmit={(reason) => {
          setResetReason(reason);
          setResetStep('confirm');
        }}
      />
      <ConfirmDialog
        open={resetStep === 'confirm'}
        onOpenChange={(o) => !o && setResetStep('closed')}
        title="Reset this attempt?"
        description={<><p>{c.fullName} will go back to Not started and can sit the exam again.</p><p className="text-muted-foreground">Reason: {resetReason}</p>{reset.isError && <p role="alert" className="text-destructive">{reset.error.message}</p>}</>}
        confirmLabel="Reset attempt"
        isPending={reset.isPending}
        onConfirm={() => reset.mutate(resetReason, { onSuccess: () => setResetStep('closed') })}
      />
    </div>
  );
}
