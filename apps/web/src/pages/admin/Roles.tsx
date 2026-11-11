// src/pages/admin/Roles.tsx
// Why: Super Admin sets up hiring (spec 2026-11-10): job profiles (Placement or
// Internship) -> rounds (duration, score weights, question lock; the question
// bank is shared by every college) -> drives (one college + batch: window, open
// switch, instructions). A deactivated job profile or drive keeps its
// candidates and results; it only drops out of the active lists.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Lock } from 'lucide-react';
import { examAvailability, JOB_PROFILE_TYPES, JOB_PROFILE_TYPE_LABELS, type DriveDto, type ExamAvailability, type JobProfileType, type RoundDto } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DriveFormDialog } from '@/components/admin/DriveFormDialog';
import { CopyQuestionsDialog } from '@/components/admin/CopyQuestionsDialog';
import { useRoles, useSaveRole, type JobRole } from '@/api/admin/roles';
import { useAddRound, useSaveDrive, useUpdateRound } from '@/api/admin/drives';
import { WEIGHT_KEYS, parseWeights, weightsError, weightsSum } from '@/lib/aiEvaluation';
import { jobProfileLabel } from '@/lib/drivePicker';
import { formatIst } from '@/lib/istTime';

const AVAIL: Record<ExamAvailability, string> = {
  OPEN: 'Open now',
  NOT_OPEN: 'Closed',
  BEFORE_WINDOW: 'Opens later',
  AFTER_WINDOW: 'Window ended',
};

// ---- job profile: add / rename / type ----------------------------------------------

const roleSchema = z.object({
  name: z.string().trim().min(1, 'Enter a job profile name').max(120, 'At most 120 characters'),
  type: z.enum(JOB_PROFILE_TYPES),
});
type RoleValues = z.infer<typeof roleSchema>;

function RoleDialog({ role, onClose }: { role: JobRole | 'new' | null; onClose: () => void }) {
  const save = useSaveRole();
  const existing = role !== null && role !== 'new' ? role : null;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<RoleValues>({
    resolver: zodResolver(roleSchema),
    values: { name: existing?.name ?? '', type: existing?.type ?? 'PLACEMENT' },
  });
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  return (
    <Dialog open={role !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'Add job profile'}</DialogTitle>
          <DialogDescription>
            {existing ? 'Rounds, drives, questions and results stay with the job profile.' : 'Round 1 is created with it. Add a drive per college to run it.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            save.mutate(existing ? { id: existing.id, name: v.name, type: v.type } : { name: v.name, type: v.type }, { onSuccess: close });
          })}
        >
          <div className="space-y-3 px-6 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="role-name">Job profile name</Label>
              <Input id="role-name" autoComplete="off" error={errors.name?.message} {...register('name')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-type">Type</Label>
              <Select id="role-type" {...register('type')}>
                {JOB_PROFILE_TYPES.map((t) => (
                  <option key={t} value={t}>{JOB_PROFILE_TYPE_LABELS[t]}</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">Placement and internship are ranked separately. The same name can exist once for each.</p>
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : existing ? 'Save' : 'Add job profile'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- round settings -------------------------------------------------------------------

const roundSchema = z
  .object({
    name: z.string().trim().max(60, 'At most 60 characters'),
    durationMinutes: z.number({ invalid_type_error: 'Enter minutes' }).int('Whole minutes').min(10, 'At least 10').max(240, 'At most 240'),
    mcqNegativeMarks: z
      .number({ invalid_type_error: 'Enter 0 for no negative marking' })
      .min(0, 'At least 0')
      .max(50, 'At most 50')
      .refine((n) => Number.isInteger(n * 4), 'Use steps of 0.25'),
    weights: z.object({ exam: z.number(), x: z.number(), xii: z.number(), cpi: z.number() }),
  })
  .refine((v) => !weightsError(v.weights), { path: ['weights'], message: 'Fix the composite weights' });
type RoundValues = z.infer<typeof roundSchema>;

function RoundDialog({ round, label, onClose }: { round: RoundDto | null; label: string; onClose: () => void }) {
  const save = useUpdateRound();
  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<RoundValues>({
    resolver: zodResolver(roundSchema),
    values: round ? { name: round.name ?? '', durationMinutes: round.durationMinutes, mcqNegativeMarks: round.mcqNegativeMarks, weights: { ...round.weights } } : undefined,
  });
  const weights = watch('weights');
  const wError = weights ? weightsError(weights) : null;
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  return (
    <Dialog open={round !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Round settings: {label}</DialogTitle>
          <DialogDescription>The same for every college's drive of this round. Window and open switch are set per drive.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            if (!round) return;
            save.mutate(
              {
                id: round.id,
                name: v.name.trim() || null,
                durationMinutes: v.durationMinutes,
                // Locked with the questions once candidates have started: never sent then.
                ...(round.questionsLocked ? {} : { mcqNegativeMarks: v.mcqNegativeMarks }),
                weights: parseWeights(v.weights),
              },
              { onSuccess: close },
            );
          })}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rd-name">Label (optional)</Label>
                <Input id="rd-name" placeholder="Aptitude" error={errors.name?.message} {...register('name')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rd-duration">Duration (minutes)</Label>
                <Input id="rd-duration" type="number" min={10} max={240} error={errors.durationMinutes?.message} {...register('durationMinutes', { valueAsNumber: true })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rd-negative">Negative marking per wrong MCQ answer</Label>
              <Input
                id="rd-negative"
                type="number"
                min={0}
                max={50}
                step={0.25}
                className="max-w-[10rem]"
                disabled={round?.questionsLocked}
                aria-describedby="rd-negative-note"
                error={errors.mcqNegativeMarks?.message}
                {...register('mcqNegativeMarks', { valueAsNumber: true })}
              />
              <p id="rd-negative-note" className="text-xs text-muted-foreground">
                {round?.questionsLocked
                  ? 'Locked because candidates have started this round. Unlock the questions to change it.'
                  : 'Marks taken off for each wrong MCQ answer. 0 = no negative marking; unanswered questions never lose marks. It can’t be more than the smallest MCQ’s marks.'}
              </p>
            </div>
            <fieldset className="space-y-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-medium">Composite score weights (%)</legend>
              <p className="text-xs text-muted-foreground">
                How the leaderboard Composite mixes exam %, Class X %, Class XII % and CPI. Must add up to 100. A missing X, XII or CPI is skipped and its weight shared among the rest.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {WEIGHT_KEYS.map((k) => (
                  <div key={k} className="space-y-1.5">
                    <Label htmlFor={`rd-w-${k}`}>{k === 'exam' ? 'Exam' : k === 'cpi' ? 'CPI' : k.toUpperCase()}</Label>
                    <Input id={`rd-w-${k}`} type="number" min={0} max={100} step={1} aria-describedby="rd-w-sum" {...register(`weights.${k}`, { valueAsNumber: true })} />
                  </div>
                ))}
              </div>
              <p id="rd-w-sum" aria-live="polite" className={wError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {weights ? `Total ${weightsSum(weights)} / 100` : ''}{wError ? `. ${wError}` : ''}
              </p>
            </fieldset>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || Boolean(wError)}>{save.isPending ? 'Saving…' : 'Save round'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- one round: settings line + its drives --------------------------------------------

interface RoundActions {
  editRound: (round: RoundDto, label: string) => void;
  copyInto: (round: RoundDto, label: string) => void;
  addDrive: (round: RoundDto, label: string) => void;
  editDrive: (drive: DriveDto, round: RoundDto, label: string) => void;
}

function RoundSection({ role, round, actions }: { role: JobRole; round: RoundDto; actions: RoundActions }) {
  const toggle = useSaveDrive();
  const label = `${jobProfileLabel(role)} · Round ${round.roundNumber}`;
  const drives = round.drives ?? [];
  const now = new Date();
  return (
    <section className="space-y-2 rounded-lg border border-border p-3" aria-label={label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Round {round.roundNumber}{round.name ? ` · ${round.name}` : ''}</span>
          <span className="text-muted-foreground">
            {round.durationMinutes} min · {round.counts.questions} questions{round.mcqNegativeMarks > 0 ? ` · −${round.mcqNegativeMarks} per wrong MCQ` : ''}
          </span>
          {round.questionsLocked && (
            <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" aria-hidden /> Questions locked</Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => actions.editRound(round, label)}>Round settings</Button>
          <Button size="sm" variant="outline" disabled={round.questionsLocked} onClick={() => actions.copyInto(round, label)}>Copy questions…</Button>
          <Button size="sm" onClick={() => actions.addDrive(round, label)}>Add drive</Button>
        </div>
      </div>
      {drives.length === 0 ? (
        <p className="text-sm text-muted-foreground">No drives yet. Add one per college (and batch) that takes this round.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>College</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Window (IST)</TableHead>
                <TableHead>Availability</TableHead>
                <TableHead>Candidates</TableHead>
                <TableHead className="w-48"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drives.map((d) => {
                const avail = examAvailability(d, now);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium" title={d.college.name}>
                      {d.college.shortCode} {!d.active && <Badge variant="outline">Inactive</Badge>}
                    </TableCell>
                    <TableCell>{d.batch}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.windowStart || d.windowEnd ? `${formatIst(d.windowStart)} to ${formatIst(d.windowEnd)}` : 'No window'}
                    </TableCell>
                    <TableCell><Badge variant={avail === 'OPEN' ? 'default' : 'outline'}>{AVAIL[avail]}</Badge></TableCell>
                    <TableCell>{d.counts.candidates} ({d.counts.started} started)</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => actions.editDrive(d, round, label)}>Edit</Button>
                        <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: d.id, active: !d.active })}>
                          {d.active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {toggle.isError && <p role="alert" className="text-sm text-destructive">{toggle.error.message}</p>}
    </section>
  );
}

// ---- page ---------------------------------------------------------------------------------

type DriveDialogState = { roundId: string; label: string; drive: DriveDto | null } | null;

export default function Roles() {
  const { data, isPending, error } = useRoles();
  const toggle = useSaveRole();
  const addRound = useAddRound();
  const [naming, setNaming] = useState<JobRole | 'new' | null>(null);
  const [toggling, setToggling] = useState<JobRole | null>(null);
  const [round, setRound] = useState<{ round: RoundDto; label: string } | null>(null);
  const [copyTarget, setCopyTarget] = useState<{ roundId: string; label: string } | null>(null);
  const [driveDialog, setDriveDialog] = useState<DriveDialogState>(null);
  const [typeFilter, setTypeFilter] = useState<JobProfileType | ''>('');

  const actions: RoundActions = {
    editRound: (r, label) => setRound({ round: r, label }),
    copyInto: (r, label) => setCopyTarget({ roundId: r.id, label }),
    addDrive: (r, label) => setDriveDialog({ roundId: r.id, label, drive: null }),
    editDrive: (d, r, label) => setDriveDialog({ roundId: r.id, label, drive: d }),
  };
  const closeToggle = () => {
    toggle.reset();
    setToggling(null);
  };
  const roles = (data ?? []).filter((r) => !typeFilter || r.type === typeFilter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Job profiles & drives</h1>
          <p className="text-sm text-muted-foreground">Questions and duration are set per round; each college's date and window per drive.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Label htmlFor="jp-type" className="sr-only">Type</Label>
            <Select id="jp-type" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as JobProfileType | '')}>
              <option value="">All types</option>
              {JOB_PROFILE_TYPES.map((t) => <option key={t} value={t}>{JOB_PROFILE_TYPE_LABELS[t]}</option>)}
            </Select>
          </div>
          <Button size="sm" onClick={() => setNaming('new')}>Add job profile</Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {data && roles.length === 0 && <p className="text-sm text-muted-foreground">No job profiles yet.</p>}

      {roles.map((r) => (
        <article key={r.id} className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label={jobProfileLabel(r)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{r.name}</h2>
              <Badge variant={r.type === 'INTERNSHIP' ? 'secondary' : 'outline'}>{JOB_PROFILE_TYPE_LABELS[r.type]}</Badge>
              {!r.active && <Badge variant="outline">Inactive</Badge>}
              <span className="text-sm text-muted-foreground">{r.counts.candidates} candidates</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setNaming(r)}>Edit</Button>
              <Button size="sm" variant="outline" disabled={addRound.isPending} onClick={() => addRound.mutate({ jobRoleId: r.id })}>
                Add round {r.rounds.length + 1}
              </Button>
              {r.active ? (
                <Button size="sm" variant="outline" onClick={() => setToggling(r)}>Deactivate</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: r.id, active: true })}>Activate</Button>
              )}
            </div>
          </div>
          {[...r.rounds].sort((a, b) => a.roundNumber - b.roundNumber).map((round) => (
            <RoundSection key={round.id} role={r} round={round} actions={actions} />
          ))}
        </article>
      ))}
      {(addRound.isError || (toggle.isError && toggling === null)) && (
        <p className="text-sm text-destructive" role="alert">{(addRound.error ?? toggle.error)?.message}</p>
      )}

      <RoleDialog role={naming} onClose={() => setNaming(null)} />
      <RoundDialog round={round?.round ?? null} label={round?.label ?? ''} onClose={() => setRound(null)} />
      <CopyQuestionsDialog target={copyTarget} onClose={() => setCopyTarget(null)} />
      <DriveFormDialog
        open={driveDialog !== null}
        roundId={driveDialog?.roundId ?? ''}
        roundLabel={driveDialog?.label ?? ''}
        drive={driveDialog?.drive ?? null}
        onClose={() => setDriveDialog(null)}
      />
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(o) => !o && closeToggle()}
        title={`Deactivate ${toggling?.name ?? 'job profile'}?`}
        description={
          <>
            It drops out of the active list. Its rounds, drives, candidates and results are kept, and you can activate it again.
            Close its drives if candidates must not start.
            {toggle.isError && <span className="mt-2 block text-destructive" role="alert">{toggle.error.message}</span>}
          </>
        }
        confirmLabel="Deactivate"
        isPending={toggle.isPending}
        onConfirm={() => toggling && toggle.mutate({ id: toggling.id, active: false }, { onSuccess: closeToggle })}
      />
    </div>
  );
}
