// src/pages/admin/Roles.tsx
// Why: Super Admin edits each role's exam settings (design §4): duration, start window,
// instructions and the open switch; and adds, renames and deactivates roles (a deactivated
// role keeps its candidates and results, it just drops out of HR's active list). Window times are typed and shown in IST and sent as
// ISO UTC; the server enforces windowEnd > windowStart too, this just fails fast.

import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRoles, useSaveRole, useUpdateSettings, type JobRole } from '@/api/admin/roles';
import { examAvailability, type ExamAvailability } from '@exam/shared';
import { formatIst, isoToIstInput, istInputToIso } from '@/lib/istTime';

const schema = z
  .object({
    durationMinutes: z.number({ invalid_type_error: 'Enter minutes' }).int('Whole minutes').min(10, 'At least 10').max(240, 'At most 240'),
    windowStart: z.string(),
    windowEnd: z.string(),
    instructions: z.string().max(10000, 'At most 10,000 characters'),
    isOpen: z.boolean(),
  })
  .refine((v) => !v.windowStart || !v.windowEnd || v.windowEnd > v.windowStart, {
    path: ['windowEnd'],
    message: 'End must be after start',
  });
type Values = z.infer<typeof schema>;

const nameSchema = z.object({ name: z.string().trim().min(1, 'Enter a role name').max(120, 'At most 120 characters') });
type NameValues = z.infer<typeof nameSchema>;

/** Add (role === 'new') or rename a role. */
function RoleNameDialog({ role, onClose }: { role: JobRole | 'new' | null; onClose: () => void }) {
  const save = useSaveRole();
  const existing = role !== null && role !== 'new' ? role : null;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    values: { name: existing?.name ?? '' },
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
          <DialogTitle>{existing ? `Rename ${existing.name}` : 'Add role'}</DialogTitle>
          <DialogDescription>
            {existing ? 'Candidates, questions and results stay with the role.' : 'The role starts closed, with default exam settings.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            save.mutate(existing ? { id: existing.id, name: v.name } : { name: v.name }, { onSuccess: close });
          })}
        >
          <div className="space-y-1.5 px-6 pb-4">
            <Label htmlFor="role-name">Role name</Label>
            <Input id="role-name" autoComplete="off" error={errors.name?.message} {...register('name')} />
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : existing ? 'Rename' : 'Add role'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const AVAIL: Record<ExamAvailability, string> = {
  OPEN: 'Open now',
  NOT_OPEN: 'Closed',
  BEFORE_WINDOW: 'Opens later',
  AFTER_WINDOW: 'Window ended',
};

function SettingsDialog({ role, onClose }: { role: JobRole | null; onClose: () => void }) {
  const save = useUpdateSettings();
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    values: role
      ? {
          durationMinutes: role.settings.durationMinutes,
          windowStart: isoToIstInput(role.settings.windowStart),
          windowEnd: isoToIstInput(role.settings.windowEnd),
          instructions: role.settings.instructions,
          isOpen: role.settings.isOpen,
        }
      : undefined,
  });
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  return (
    <Dialog open={role !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Exam settings: {role?.name}</DialogTitle>
          <DialogDescription>Times are in IST (Asia/Kolkata). Candidates can only start inside the window.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            if (!role) return;
            save.mutate(
              {
                id: role.id,
                durationMinutes: v.durationMinutes,
                windowStart: istInputToIso(v.windowStart),
                windowEnd: istInputToIso(v.windowEnd),
                instructions: v.instructions,
                isOpen: v.isOpen,
              },
              { onSuccess: close },
            );
          })}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="rs-duration">Duration (minutes)</Label>
              <Input id="rs-duration" type="number" min={10} max={240} error={errors.durationMinutes?.message} {...register('durationMinutes', { valueAsNumber: true })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rs-start">Window start (IST)</Label>
                <Input id="rs-start" type="datetime-local" error={errors.windowStart?.message} {...register('windowStart')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-end">Window end (IST)</Label>
                <Input id="rs-end" type="datetime-local" error={errors.windowEnd?.message} {...register('windowEnd')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rs-instr">Instructions shown before Start</Label>
              <Textarea id="rs-instr" rows={8} {...register('instructions')} />
              {errors.instructions && <p className="text-xs text-destructive">{errors.instructions.message}</p>}
            </div>
            <div className="flex items-center gap-3">
              <Controller
                control={control}
                name="isOpen"
                render={({ field }) => (
                  <Switch id="rs-open" checked={field.value} onCheckedChange={field.onChange} aria-label="Exam open" />
                )}
              />
              <Label htmlFor="rs-open">Exam is open for this role</Label>
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save settings'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Roles() {
  const { data, isPending, error } = useRoles();
  const [editing, setEditing] = useState<JobRole | null>(null);
  const [naming, setNaming] = useState<JobRole | 'new' | null>(null);
  const [toggling, setToggling] = useState<JobRole | null>(null);
  const toggle = useSaveRole();
  const now = new Date();
  const closeToggle = () => {
    toggle.reset();
    setToggling(null);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-foreground">Exam Settings</h1>
        <Button size="sm" onClick={() => setNaming('new')}>Add role</Button>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Window (IST)</TableHead>
              <TableHead>Availability</TableHead>
              <TableHead>Questions</TableHead>
              <TableHead>Candidates</TableHead>
              <TableHead className="w-64"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.name} {!r.active && <Badge variant="outline">Inactive</Badge>}
                </TableCell>
                <TableCell>{r.settings.durationMinutes} min</TableCell>
                <TableCell className="text-muted-foreground">
                  {r.settings.windowStart || r.settings.windowEnd
                    ? `${formatIst(r.settings.windowStart)} to ${formatIst(r.settings.windowEnd)}`
                    : 'No window'}
                </TableCell>
                <TableCell>
                  <Badge variant={examAvailability(r.settings, now) === 'OPEN' ? 'default' : 'outline'}>
                    {AVAIL[examAvailability(r.settings, now)]}
                  </Badge>
                </TableCell>
                <TableCell>{r.counts.questions}</TableCell>
                <TableCell>{r.counts.candidates}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(r)}>Edit</Button>
                    <Button size="sm" variant="outline" onClick={() => setNaming(r)}>Rename</Button>
                    {r.active ? (
                      <Button size="sm" variant="outline" onClick={() => setToggling(r)}>Deactivate</Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ id: r.id, active: true })}
                      >
                        Activate
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {toggle.isError && toggling === null && <p className="text-sm text-destructive" role="alert">{toggle.error.message}</p>}
      <SettingsDialog role={editing} onClose={() => setEditing(null)} />
      <RoleNameDialog role={naming} onClose={() => setNaming(null)} />
      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(o) => !o && closeToggle()}
        title={`Deactivate ${toggling?.name ?? 'role'}?`}
        description={
          <>
            It drops out of the active role list. Its candidates, questions and results are kept, and you can activate it again.
            Close the exam for this role in Edit if candidates must not start.
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
