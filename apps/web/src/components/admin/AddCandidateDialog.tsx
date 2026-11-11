// src/components/admin/AddCandidateDialog.tsx
// Why: add one candidate by hand instead of a CSV import. Same fields and limits as the
// candidate edit form; name, email and drive (job profile · round · college · batch;
// spec 2026-11-10) are required, everything else optional.
// The server mints the candidate code and rejects an email or mobile already in use.

import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { normalizeMobile } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DrivePicker } from '@/components/admin/DrivePicker';
import { useCreateCandidate, type CandidateRow } from '@/api/admin/candidates';

const optNum = (min: number, max: number, label: string) =>
  z.string().trim().refine((v) => v === '' || (!Number.isNaN(Number(v)) && Number(v) >= min && Number(v) <= max), `${label} must be ${min} to ${max}`);

const schema = z.object({
  fullName: z.string().trim().min(2, 'At least 2 characters').max(150),
  email: z.string().trim().email('Enter a valid email'),
  mobile: z.string().trim().refine((v) => v === '' || normalizeMobile(v) !== null, 'Enter a 10-digit Indian mobile number'),
  rollNumber: z.string().trim().max(200),
  xPercentage: optNum(0, 100, 'X %'),
  xiiPercentage: optNum(0, 100, 'XII %'),
  majorCpi: optNum(0, 10, 'CPI'),
  discipline: z.string().trim().max(200),
  programme: z.string().trim().max(200),
  driveId: z.string().min(1, 'Choose a drive'),
});
type Values = z.infer<typeof schema>;

const EMPTY: Values = {
  fullName: '', email: '', mobile: '', rollNumber: '', xPercentage: '', xiiPercentage: '',
  majorCpi: '', discipline: '', programme: '', driveId: '',
};
const num = (v: string) => (v === '' ? null : Number(v));
const txt = (v: string) => (v === '' ? null : v);

export function AddCandidateDialog({
  open,
  defaultDriveId,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultDriveId?: string;
  onClose: () => void;
  onCreated?: (c: CandidateRow) => void;
}) {
  const create = useCreateCandidate();
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    values: { ...EMPTY, driveId: defaultDriveId ?? '' },
  });
  const close = () => {
    reset();
    create.reset();
    onClose();
  };
  const field = (id: keyof Values, label: string, type = 'text', required = false) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ac-${id}`}>{label}{required && <span className="text-destructive"> *</span>}</Label>
      <Input id={`ac-${id}`} type={type} step={type === 'number' ? 'any' : undefined} error={errors[id]?.message} {...register(id)} />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add candidate</DialogTitle>
          <DialogDescription>A candidate code is assigned automatically. They sign in with this email or mobile.</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6"
          onSubmit={handleSubmit((v) =>
            create.mutate(
              {
                fullName: v.fullName,
                email: v.email.toLowerCase(),
                mobile: v.mobile === '' ? null : normalizeMobile(v.mobile),
                rollNumber: txt(v.rollNumber),
                xPercentage: num(v.xPercentage),
                xiiPercentage: num(v.xiiPercentage),
                majorCpi: num(v.majorCpi),
                discipline: txt(v.discipline),
                programme: txt(v.programme),
                driveId: v.driveId,
              },
              {
                onSuccess: (c) => {
                  onCreated?.(c);
                  close();
                },
              },
            ),
          )}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {field('fullName', 'Name', 'text', true)}
            {field('email', 'Email', 'email', true)}
            <div className="space-y-1.5 sm:col-span-2">
              <Controller
                control={control}
                name="driveId"
                render={({ field: f }) => <DrivePicker value={f.value || null} onChange={(id) => f.onChange(id ?? '')} idPrefix="ac" inline />}
              />
              {errors.driveId && <p className="text-xs text-destructive">{errors.driveId.message}</p>}
            </div>
            {field('mobile', 'Mobile', 'tel')}
            {field('rollNumber', 'Roll number')}
            {field('xPercentage', 'X percentage', 'number')}
            {field('xiiPercentage', 'XII percentage', 'number')}
            {field('majorCpi', 'Major CPI', 'number')}
            {field('discipline', 'Discipline')}
            {field('programme', 'Programme')}
          </div>
          {create.isError && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add candidate'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
