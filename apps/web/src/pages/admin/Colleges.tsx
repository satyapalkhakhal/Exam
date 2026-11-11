// src/pages/admin/Colleges.tsx
// Why: Super Admin keeps the list of colleges candidates come from (spec
// 2026-11-10). A college is never deleted, only deactivated: it then drops out of
// the "Add drive" list but keeps its drives and results.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { CollegeDto } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useColleges, useSaveCollege } from '@/api/admin/drives';

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the college name').max(120, 'At most 120 characters'),
  shortCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{2,12}$/, 'Use 2–12 letters, digits or "-"'),
});
type Values = z.infer<typeof schema>;

function CollegeDialog({ college, onClose }: { college: CollegeDto | 'new' | null; onClose: () => void }) {
  const save = useSaveCollege();
  const existing = college !== null && college !== 'new' ? college : null;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    values: { name: existing?.name ?? '', shortCode: existing?.shortCode ?? '' },
  });
  const close = () => {
    reset();
    save.reset();
    onClose();
  };
  return (
    <Dialog open={college !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'Add college'}</DialogTitle>
          <DialogDescription>The short code appears in drive names, e.g. "Quant Analyst · Round 1 · IITG · Nov 2026".</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={handleSubmit((v) => {
            const body = { name: v.name.trim(), shortCode: v.shortCode.trim().toUpperCase() };
            save.mutate(existing ? { id: existing.id, ...body } : body, { onSuccess: close });
          })}
        >
          <div className="space-y-3 px-6 pb-4">
            <div className="space-y-1.5">
              <Label htmlFor="col-name">College name</Label>
              <Input id="col-name" autoComplete="off" placeholder="IIT Guwahati" error={errors.name?.message} {...register('name')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="col-code">Short code</Label>
              <Input id="col-code" autoComplete="off" placeholder="IITG" className="uppercase" error={errors.shortCode?.message} {...register('shortCode')} />
            </div>
            {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : existing ? 'Save' : 'Add college'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Colleges() {
  const { data, isPending, error } = useColleges();
  const toggle = useSaveCollege();
  const [editing, setEditing] = useState<CollegeDto | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Colleges</h1>
          <p className="text-sm text-muted-foreground">Each drive runs one round of a job profile at one college.</p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>Add college</Button>
      </div>
      {(error || toggle.error) && <p className="text-sm text-destructive" role="alert">{(error ?? toggle.error)?.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>College</TableHead>
              <TableHead>Short code</TableHead>
              <TableHead>Drives</TableHead>
              <TableHead className="w-56"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && <TableRow><TableCell colSpan={4} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {data?.length === 0 && <TableRow><TableCell colSpan={4} className="text-muted-foreground">No colleges yet.</TableCell></TableRow>}
            {data?.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name} {!c.active && <Badge variant="outline">Inactive</Badge>}</TableCell>
                <TableCell><Badge variant="secondary">{c.shortCode}</Badge></TableCell>
                <TableCell>{c.driveCount}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setEditing(c)}>Edit</Button>
                    <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: c.id, active: !c.active })}>
                      {c.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <CollegeDialog college={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
