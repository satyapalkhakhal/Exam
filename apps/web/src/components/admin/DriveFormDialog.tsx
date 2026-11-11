// src/components/admin/DriveFormDialog.tsx
// Why: add a drive to a round (college + batch + window) or edit one (spec
// 2026-11-10). Window times are typed and shown in IST and sent as ISO UTC; the
// server enforces end > start too, this just fails fast. Also opened prefilled
// (college + batch) by "Move shortlisted to Round n+1" when the next drive is missing.

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { DriveDto } from '@exam/shared';
import { DRIVE_BATCH_MAX } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useColleges, useSaveDrive } from '@/api/admin/drives';
import { isoToIstInput, istInputToIso } from '@/lib/istTime';

const schema = z
  .object({
    collegeId: z.string(),
    batch: z.string().trim().min(1, 'Enter a batch, e.g. "Nov 2026"').max(DRIVE_BATCH_MAX, `At most ${DRIVE_BATCH_MAX} characters`),
    windowStart: z.string(),
    windowEnd: z.string(),
    instructions: z.string().max(10000, 'At most 10,000 characters'),
    isOpen: z.boolean(),
  })
  .refine((v) => !v.windowStart || !v.windowEnd || v.windowEnd > v.windowStart, { path: ['windowEnd'], message: 'End must be after start' });
type Values = z.infer<typeof schema>;

export interface DriveFormDialogProps {
  open: boolean;
  /** The round a new drive goes into (ignored when editing). */
  roundId: string;
  /** e.g. "Quant Analyst · Round 2", shown in the title. */
  roundLabel: string;
  /** Editing this drive; omitted = add a new one. */
  drive?: DriveDto | null;
  /** Prefill for a new drive (e.g. the same college + batch as the Round 1 drive). */
  prefill?: { collegeId: string; batch: string };
  onClose: () => void;
  onSaved?: (drive: DriveDto) => void;
}

export function DriveFormDialog({ open, roundId, roundLabel, drive, prefill, onClose, onSaved }: DriveFormDialogProps) {
  const save = useSaveDrive();
  const colleges = useColleges();
  const editing = drive ?? null;
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    values: open
      ? {
          collegeId: editing?.college.id ?? prefill?.collegeId ?? '',
          batch: editing?.batch ?? prefill?.batch ?? '',
          windowStart: isoToIstInput(editing?.windowStart ?? null),
          windowEnd: isoToIstInput(editing?.windowEnd ?? null),
          instructions: editing?.instructions ?? '',
          isOpen: editing?.isOpen ?? false,
        }
      : undefined,
  });
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  const activeColleges = (colleges.data ?? []).filter((c) => c.active || c.id === editing?.college.id);
  // The server refuses a batch change once people are in the drive (same-round+batch rule, Round 2 pairing).
  const batchLocked = Boolean(editing && editing.counts.candidates > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit drive: ${editing.displayName}` : `Add drive to ${roundLabel}`}</DialogTitle>
          <DialogDescription>One college, one batch. Times are in IST; candidates can only start inside the window while the drive is open.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            if (!editing && !v.collegeId) {
              setError('collegeId', { message: 'Choose a college' });
              return;
            }
            const fields = {
              batch: v.batch.trim(),
              windowStart: istInputToIso(v.windowStart),
              windowEnd: istInputToIso(v.windowEnd),
              instructions: v.instructions,
              isOpen: v.isOpen,
            };
            save.mutate(editing ? { id: editing.id, ...fields } : { roundId, collegeId: v.collegeId, ...fields }, {
              onSuccess: (saved) => {
                onSaved?.(saved);
                close();
              },
            });
          })}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="df-college">College</Label>
                <Select id="df-college" disabled={Boolean(editing)} error={errors.collegeId?.message} {...register('collegeId')}>
                  <option value="">{colleges.isPending ? 'Loading…' : 'Select a college…'}</option>
                  {activeColleges.map((c) => (
                    <option key={c.id} value={c.id}>{c.shortCode} · {c.name}</option>
                  ))}
                </Select>
                {!editing && colleges.data && activeColleges.length === 0 && (
                  <p className="text-xs text-muted-foreground">No active colleges yet. Add one on the Colleges page.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="df-batch">Batch</Label>
                <Input
                  id="df-batch"
                  placeholder="Nov 2026"
                  autoComplete="off"
                  readOnly={batchLocked}
                  aria-describedby={batchLocked ? 'df-batch-locked' : undefined}
                  error={errors.batch?.message}
                  {...register('batch')}
                />
                {batchLocked && (
                  <p id="df-batch-locked" className="text-xs text-muted-foreground">This drive has candidates, so its batch stays. Add a new drive for another batch.</p>
                )}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="df-start">Window start (IST)</Label>
                <Input id="df-start" type="datetime-local" error={errors.windowStart?.message} {...register('windowStart')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="df-end">Window end (IST)</Label>
                <Input id="df-end" type="datetime-local" error={errors.windowEnd?.message} {...register('windowEnd')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="df-instr">Instructions shown before Start</Label>
              <Textarea id="df-instr" rows={6} {...register('instructions')} />
              {errors.instructions && <p className="text-xs text-destructive">{errors.instructions.message}</p>}
            </div>
            <div className="flex items-center gap-3">
              <Controller
                control={control}
                name="isOpen"
                render={({ field }) => <Switch id="df-open" checked={field.value} onCheckedChange={field.onChange} aria-label="Drive open" />}
              />
              <Label htmlFor="df-open">Open for candidates</Label>
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : editing ? 'Save drive' : 'Add drive'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
