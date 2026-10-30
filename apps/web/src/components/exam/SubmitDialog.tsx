// src/components/exam/SubmitDialog.tsx
// Why: a final check before the attempt is locked: how many questions are still blank or
// marked for review. A plain confirm, no phrase to type.

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: number;
  unanswered: number;
  marked: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}

export function SubmitDialog({ open, onOpenChange, total, unanswered, marked, pending, error, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Submit your exam?</DialogTitle>
          <DialogDescription>You can't change your answers after you submit.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4 text-sm">
          <dl className="grid grid-cols-[1fr_auto] gap-y-1.5">
            <dt className="text-muted-foreground">Questions</dt>
            <dd className="font-semibold">{total}</dd>
            <dt className="text-muted-foreground">Unanswered</dt>
            <dd className={unanswered > 0 ? 'font-semibold text-amber-700' : 'font-semibold'}>{unanswered}</dd>
            <dt className="text-muted-foreground">Marked for review</dt>
            <dd className={marked > 0 ? 'font-semibold text-violet-700' : 'font-semibold'}>{marked}</dd>
          </dl>
          <div aria-live="polite">{error && <p className="text-destructive">{error}</p>}</div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep working
          </Button>
          <Button type="button" onClick={onConfirm} loading={pending}>
            Submit exam
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
