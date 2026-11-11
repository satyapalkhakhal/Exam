// src/components/admin/CopyQuestionsDialog.tsx
// Why: an internship (or another round) that uses an existing exam gets its
// question bank without re-importing (spec 2026-11-10 §5.1). A round that
// already has questions needs "Replace" (its questions are deactivated, never deleted).

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useRoles } from '@/api/admin/roles';
import { useCopyQuestions } from '@/api/admin/drives';
import { ApiError } from '@/lib/api';
import { copyResultText, roundOptions } from '@/lib/drivePicker';
import type { CopyQuestionsResultDto } from '@exam/shared';

export function CopyQuestionsDialog({ target, onClose }: { target: { roundId: string; label: string } | null; onClose: () => void }) {
  const roles = useRoles();
  const copy = useCopyQuestions();
  const [from, setFrom] = useState('');
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState<CopyQuestionsResultDto | null>(null);
  const options = roundOptions(roles.data ?? []).filter((o) => o.id !== target?.roundId);
  const needsReplace = copy.error instanceof ApiError && copy.error.code === 'TARGET_HAS_QUESTIONS';
  const close = () => {
    setFrom('');
    setReplace(false);
    setDone(null);
    copy.reset();
    onClose();
  };
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Copy questions into {target?.label}</DialogTitle>
          <DialogDescription>Copies the active questions of another round, with their marks, guidance and order.</DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (target && from) copy.mutate({ targetRoundId: target.roundId, fromRoundId: from, replace }, { onSuccess: setDone });
          }}
        >
          <div className="space-y-3 px-6 pb-4">
            {done && (
              <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{copyResultText(done)}</p>
            )}
            <div className={done ? 'hidden' : 'space-y-1.5'}>
              <Label htmlFor="cq-from">Copy from</Label>
              <Select id="cq-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Select a round…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </Select>
            </div>
            <label className={done ? 'hidden' : 'flex items-start gap-2 text-sm'}>
              <Checkbox checked={replace} onChange={(e) => setReplace(e.target.checked)} aria-label="Replace existing questions" />
              <span>Replace this round's current questions (they are deactivated, not deleted)</span>
            </label>
            {copy.isError && (
              <p role="alert" className="text-sm text-destructive">
                {needsReplace ? 'This round already has questions. Tick "Replace" to copy anyway.' : copy.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            {done ? (
              <Button type="button" onClick={close}>Done</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close}>Cancel</Button>
                <Button type="submit" disabled={!from || copy.isPending}>{copy.isPending ? 'Copying…' : 'Copy questions'}</Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
