// src/pages/admin/AdminUsers.tsx
// Why: Super Admin manages who can sign in (plan Task 5). The server refuses
// self-deactivation and demoting the last Super Admin (CONFLICT); its message is
// shown in the dialog.

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AdminRole } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAdminUsers, useCreateAdminUser, useUpdateAdminUser, type AdminUserRow } from '@/api/admin/users';

const roleSchema = z.enum([AdminRole.SUPER_ADMIN, AdminRole.EVALUATOR]);
const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  email: z.string().trim().email('Enter a valid email'),
  role: roleSchema,
  password: z.string().min(8, 'At least 8 characters'),
});
const editSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  role: roleSchema,
  active: z.boolean(),
  password: z.string().refine((v) => v === '' || v.length >= 8, 'At least 8 characters'),
});
type CreateValues = z.infer<typeof createSchema>;
type EditValues = z.infer<typeof editSchema>;

const roleText = (r: AdminRole) => (r === AdminRole.SUPER_ADMIN ? 'Super Admin' : 'Evaluator');
const PAGE_SIZE_FALLBACK = 20;

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateAdminUser();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', email: '', role: AdminRole.EVALUATOR, password: '' },
  });
  const close = () => {
    reset();
    create.reset();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add admin user</DialogTitle>
          <DialogDescription>They sign in with this email and password, then a one-time code.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" noValidate onSubmit={handleSubmit((v) => create.mutate(v, { onSuccess: close }))}>
          <div className="space-y-1.5">
            <Label htmlFor="cu-name">Name</Label>
            <Input id="cu-name" error={errors.name?.message} {...register('name')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-email">Email</Label>
            <Input id="cu-email" type="email" error={errors.email?.message} {...register('email')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-role">Role</Label>
            <Select id="cu-role" {...register('role')}>
              <option value={AdminRole.EVALUATOR}>Evaluator</option>
              <option value={AdminRole.SUPER_ADMIN}>Super Admin</option>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cu-pw">Initial password</Label>
            <Input id="cu-pw" type="password" autoComplete="new-password" error={errors.password?.message} {...register('password')} />
          </div>
          {create.isError && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ user, onClose }: { user: AdminUserRow | null; onClose: () => void }) {
  const update = useUpdateAdminUser();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    values: user ? { name: user.name, role: user.role, active: user.active, password: '' } : undefined,
  });
  const close = () => {
    reset();
    update.reset();
    onClose();
  };
  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {user?.email}</DialogTitle>
          <DialogDescription>Leave the password blank to keep it. A new password also clears any lockout.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          noValidate
          onSubmit={handleSubmit((v) => {
            if (!user) return;
            const { password, ...rest } = v;
            update.mutate({ id: user.id, ...rest, ...(password ? { password } : {}) }, { onSuccess: close });
          })}
        >
          <div className="space-y-1.5">
            <Label htmlFor="eu-name">Name</Label>
            <Input id="eu-name" error={errors.name?.message} {...register('name')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eu-role">Role</Label>
            <Select id="eu-role" {...register('role')}>
              <option value={AdminRole.EVALUATOR}>Evaluator</option>
              <option value={AdminRole.SUPER_ADMIN}>Super Admin</option>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" {...register('active')} />
            Active
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="eu-pw">Reset password</Label>
            <Input id="eu-pw" type="password" autoComplete="new-password" error={errors.password?.message} {...register('password')} />
          </div>
          {update.isError && <p role="alert" className="text-sm text-destructive">{update.error.message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AdminUsers() {
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const { data, isPending, error } = useAdminUsers(page);
  const pageSize = data?.pageSize ?? PAGE_SIZE_FALLBACK;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Admin Users</h1>
        <Button onClick={() => setCreating(true)}>Add user</Button>
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="w-20"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending && (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {data?.items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{roleText(u.role)}</TableCell>
                <TableCell><Badge variant={u.active ? 'default' : 'outline'}>{u.active ? 'Active' : 'Inactive'}</Badge></TableCell>
                <TableCell className="text-muted-foreground">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</TableCell>
                <TableCell><Button size="sm" variant="outline" onClick={() => setEditing(u)}>Edit</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && (
        <Pagination page={data.page} pageSize={pageSize} total={data.total} totalPages={Math.max(1, Math.ceil(data.total / pageSize))} onPageChange={setPage} />
      )}
      <CreateDialog open={creating} onClose={() => setCreating(false)} />
      <EditDialog user={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
