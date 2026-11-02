// src/components/admin/BulkJobRoleDialog.tsx
// Why: move many candidates to another job role at once (e.g. a file imported under the
// wrong one). The server moves only candidates who have not started an exam and reports
// everyone it skipped, with the reason, which this dialog shows after the move.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useBulkJobRole, type BulkJobRoleResult } from '@/api/admin/candidates';

const REASON: Record<BulkJobRoleResult['skipped'][number]['reason'], string> = {
  STARTED: 'Already started an exam',
  SAME_ROLE: 'Already in this job role',
  SAME_PERSON_HAS_ROLE: 'This person already has an application for this role',
  NOT_FOUND: 'No longer exists',
};

export function BulkJobRoleDialog({
  open,
  candidateIds,
  roles,
  onClose,
  onDone,
}: {
  open: boolean;
  candidateIds: string[];
  roles: Array<{ id: string; name: string }>;
  onClose: () => void;
  /** Called after a successful move so the page can clear its selection. */
  onDone: () => void;
}) {
  const move = useBulkJobRole();
  const [jobRoleId, setJobRoleId] = useState('');
  const [result, setResult] = useState<BulkJobRoleResult | null>(null);
  const close = () => {
    setJobRoleId('');
    setResult(null);
    move.reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change job role</DialogTitle>
          <DialogDescription>
            {result
              ? `Moved ${result.updated} candidate${result.updated === 1 ? '' : 's'}.`
              : `Move ${candidateIds.length} selected candidate${candidateIds.length === 1 ? '' : 's'} to another job role. Candidates who have started an exam are skipped.`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {!result ? (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-role">New job role</Label>
              <Select id="bulk-role" value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)}>
                <option value="">Select a job role…</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </Select>
            </div>
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
                      <span className="text-muted-foreground">{REASON[s.reason]}</span>
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
                  disabled={!jobRoleId || move.isPending}
                  onClick={() =>
                    move.mutate(
                      { candidateIds, jobRoleId },
                      {
                        onSuccess: (r) => {
                          setResult(r);
                          onDone();
                        },
                      },
                    )
                  }
                >
                  {move.isPending ? 'Moving…' : `Move ${candidateIds.length}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
