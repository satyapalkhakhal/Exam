// src/components/admin/ReasonDialog.tsx
// Why: Reopen (reason required) and Shortlist/Reject (comment optional) share one small
// form dialog, so both go through React Hook Form + Zod and keep server errors in view.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  required: boolean;
  confirmLabel: string;
  isPending: boolean;
  error?: string | null;
  onSubmit: (text: string) => void;
}

export function ReasonDialog({ open, onOpenChange, title, description, label, required, confirmLabel, isPending, error, onSubmit }: Props) {
  const schema = z.object({ text: required ? z.string().trim().min(1, `${label} is required`).max(500) : z.string().trim().max(500) });
  type V = z.infer<typeof schema>;
  const { register, handleSubmit, reset, formState } = useForm<V>({ resolver: zodResolver(schema), defaultValues: { text: '' } });
  useEffect(() => {
    if (open) reset({ text: '' });
  }, [open, reset]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit((v) => onSubmit(v.text))} className="space-y-4 p-6">
          <DialogHeader className="p-0">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason-text">{label}</Label>
            <Textarea id="reason-text" rows={3} {...register('text')} />
            {formState.errors.text && <p className="text-xs text-destructive" role="alert">{formState.errors.text.message}</p>}
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <DialogFooter className="p-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? 'Working…' : confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
