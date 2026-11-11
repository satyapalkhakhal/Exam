// src/components/admin/PromoteDialog.tsx
// Why: "Move shortlisted to Round n+1" (spec 2026-11-10 §5.3). Every SHORTLISTED
// candidate of this drive gets an entry in the next round's drive for the same
// college and batch; pressing it again moves nobody twice. When that drive does
// not exist yet, the dialog offers to create it (prefilled) and then retries.

import { useState } from 'react';
import type { DriveDto, PromoteResultDto } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DriveFormDialog } from '@/components/admin/DriveFormDialog';
import { usePromote } from '@/api/admin/drives';
import { ApiError } from '@/lib/api';

interface MissingDrive {
  roundId: string;
  collegeId: string;
  batch: string;
}

export function PromoteDialog({ drive, onClose }: { drive: DriveDto | null; onClose: () => void }) {
  const promote = usePromote();
  const [result, setResult] = useState<PromoteResultDto | null>(null);
  const [creating, setCreating] = useState<MissingDrive | null>(null);
  const next = (drive?.roundNumber ?? 0) + 1;
  const error = promote.error instanceof ApiError ? promote.error : null;
  const missing = error?.code === 'NEXT_DRIVE_MISSING' ? (error.details as MissingDrive) : null;

  const run = () => drive && promote.mutate(drive.id, { onSuccess: setResult });
  const close = () => {
    setResult(null);
    setCreating(null);
    promote.reset();
    onClose();
  };

  return (
    <>
      <Dialog open={drive !== null && creating === null} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Move shortlisted to Round {next}</DialogTitle>
            <DialogDescription>
              {drive
                ? `Every shortlisted candidate of ${drive.displayName} gets a Round ${next} entry in the ${drive.college.shortCode} · ${drive.batch} drive (new candidate code, not started). Their Round ${drive.roundNumber} result stays.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-4 text-sm" aria-live="polite">
            {result && (
              <>
                <p className="font-medium">
                  {result.moved} moved, {result.alreadyThere} already in Round {next}{result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}.
                </p>
                {result.skipped.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Skipped (already in another college's Round {next} drive for this batch): {result.skipped.map((s) => s.candidateCode).join(', ')}
                  </p>
                )}
              </>
            )}
            {missing && (
              <div role="alert" className="space-y-2 rounded-md border border-border bg-muted p-3">
                <p>{error?.message}</p>
                <Button size="sm" onClick={() => setCreating(missing)}>Create that drive</Button>
              </div>
            )}
            {error && !missing && <p role="alert" className="text-destructive">{error.message}</p>}
            {promote.isError && !error && <p role="alert" className="text-destructive">{promote.error.message}</p>}
          </div>
          <DialogFooter>
            {result ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close}>Cancel</Button>
                <Button disabled={promote.isPending || Boolean(missing)} onClick={run}>
                  {promote.isPending ? 'Moving…' : `Move shortlisted to Round ${next}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DriveFormDialog
        open={creating !== null}
        roundId={creating?.roundId ?? ''}
        roundLabel={drive ? `${drive.jobRoleName} · Round ${next}` : ''}
        prefill={creating ? { collegeId: creating.collegeId, batch: creating.batch } : undefined}
        onClose={() => setCreating(null)}
        onSaved={() => {
          setCreating(null);
          promote.reset();
          run();
        }}
      />
    </>
  );
}
