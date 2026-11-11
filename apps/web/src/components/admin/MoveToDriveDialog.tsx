// src/components/admin/MoveToDriveDialog.tsx
// Why: move many candidates into one drive (spec 2026-11-10), e.g. a file imported
// under the wrong college. Within the same round anyone can move (same questions);
// into another round only those who have not started. The server reports everyone
// it skipped, with the reason, which this dialog shows after the move.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DrivePicker } from '@/components/admin/DrivePicker';
import { useMoveToDrive, type MoveSkipReason } from '@/api/admin/candidates';
import type { CandidateMoveResultDto } from '@exam/shared';

export const MOVE_REASON: Record<MoveSkipReason, string> = {
  STARTED: 'Already started — can only move within the same round',
  SAME_DRIVE: 'Already in this drive',
  NOT_FOUND: 'Not found',
  SAME_ROUND_BATCH: "Already in another college's drive for this round and batch",
};

export function MoveToDriveDialog({
  open,
  candidateIds,
  onClose,
  onDone,
}: {
  open: boolean;
  candidateIds: string[];
  onClose: () => void;
  /** Called after a successful move so the page can clear its selection. */
  onDone: () => void;
}) {
  const move = useMoveToDrive();
  const [driveId, setDriveId] = useState<string | null>(null);
  const [result, setResult] = useState<CandidateMoveResultDto | null>(null);
  const close = () => {
    setDriveId(null);
    setResult(null);
    move.reset();
    onClose();
  };
  const n = candidateIds.length;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Move to drive</DialogTitle>
          <DialogDescription>
            {result
              ? `Moved ${result.updated} candidate${result.updated === 1 ? '' : 's'}.`
              : `Move ${n} selected candidate${n === 1 ? '' : 's'} into another drive. Within the same round anyone can move; into another round only those who have not started.`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {!result ? (
            <DrivePicker value={driveId} onChange={setDriveId} idPrefix="move" />
          ) : (
            result.skipped.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Skipped ({result.skipped.length})</p>
                <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
                  {result.skipped.map((s) => (
                    <li key={s.candidateId} className="flex justify-between gap-3">
                      <span>
                        {s.fullName ?? 'Unknown'} <span className="font-mono text-xs text-muted-foreground">{s.candidateCode ?? ''}</span>
                      </span>
                      <span className="text-right text-muted-foreground">{MOVE_REASON[s.reason]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
          {move.isError && <p role="alert" className="text-sm text-destructive">{move.error.message}</p>}
          <DialogFooter>
            {result ? (
              <Button type="button" onClick={close}>Done</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close}>Cancel</Button>
                <Button
                  type="button"
                  disabled={!driveId || move.isPending}
                  onClick={() =>
                    driveId &&
                    move.mutate(
                      { candidateIds, driveId },
                      {
                        onSuccess: (r) => {
                          setResult(r);
                          onDone();
                        },
                      },
                    )
                  }
                >
                  {move.isPending ? 'Moving…' : `Move ${n}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
