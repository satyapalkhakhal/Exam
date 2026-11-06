// src/components/admin/AiSubmissionsToolbar.tsx
// Why: Super Admin controls for AI evaluation on the Submissions page (docs/ai-evaluation.md
// §2, §9): start a run for the filtered role, watch its progress, and bulk-accept AI marks.
// The server enforces everything (exam over, AI configured, locks); this only explains it.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { aiErrorMessage, formatTokens, hasRunningRun, runPercent, runProgressLabel, summariseSkips } from '@/lib/aiEvaluation';
import { useAiRuns, useBulkAcceptAi, useCancelAiRun, useStartAiRun } from '@/api/admin/aiEvaluation';

function ErrorText({ error }: { error: Error }) {
  const friendly = error instanceof ApiError ? aiErrorMessage(error.code) : null;
  if (!friendly) return <p role="alert" className="text-sm text-destructive">{error.message}</p>;
  return (
    <p role="alert" className="text-sm text-destructive">
      {friendly.text}
      {friendly.linkToIntegrations && <> <Link to="/admin/integrations" className="underline">Integrations</Link>.</>}
    </p>
  );
}

interface Props {
  jobRoleId: string;
  /** Submissions matching the current filters; used to approximate how many will be graded. */
  total: number;
  selectedIds: string[];
  onClearSelection: () => void;
}

export function AiSubmissionsToolbar({ jobRoleId, total, selectedIds, onClearSelection }: Props) {
  const qc = useQueryClient();
  const runs = useAiRuns(jobRoleId, Boolean(jobRoleId));
  const start = useStartAiRun();
  const cancel = useCancelAiRun();
  const accept = useBulkAcceptAi();
  const [evaluating, setEvaluating] = useState(false);
  const [force, setForce] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [scope, setScope] = useState<'selected' | 'role'>('role');
  const [onlyClean, setOnlyClean] = useState(true);

  const running = hasRunningRun(runs.data);
  const wasRunning = useRef(false);
  // When a run finishes, the AI columns on the list are stale.
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ['admin', 'submissions'] });
    wasRunning.current = running;
  }, [running, qc]);

  const active = (runs.data ?? []).filter((r) => r.status === 'RUNNING');
  const latestDone = running ? undefined : runs.data?.[0];

  const closeEvaluate = () => { setEvaluating(false); setForce(false); start.reset(); };
  const closeAccept = () => { setAccepting(false); accept.reset(); };
  const useSelected = scope === 'selected' && selectedIds.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!jobRoleId || running} onClick={() => setEvaluating(true)} title={jobRoleId ? undefined : 'Filter by one role first'}>
          Evaluate with AI
        </Button>
        <Button variant="outline" onClick={() => { setScope(selectedIds.length > 0 ? 'selected' : 'role'); setAccepting(true); }} disabled={!jobRoleId && selectedIds.length === 0}>
          Bulk accept AI marks
        </Button>
        {!jobRoleId && <span className="text-xs text-muted-foreground">Pick a role in the Role column filter to evaluate it.</span>}
      </div>

      {active.map((r) => (
        <div key={r.id} className="space-y-2 rounded-lg border border-border bg-card p-3" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span><span className="font-medium">AI evaluation running</span>{r.jobRole ? ` for ${r.jobRole.name}` : ''}: {runProgressLabel(r)}</span>
            <span className="text-xs text-muted-foreground">Tokens in {formatTokens(r.inputTokens)} / out {formatTokens(r.outputTokens)}</span>
            <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel</Button>
          </div>
          <div className="h-2 overflow-hidden rounded bg-muted" aria-hidden="true">
            <div className="h-full bg-primary transition-all" style={{ width: `${runPercent(r)}%` }} />
          </div>
        </div>
      ))}
      {cancel.isError && <ErrorText error={cancel.error} />}
      {latestDone && (
        <p className="text-xs text-muted-foreground">
          Last AI run ({latestDone.status === 'CANCELLED' ? 'cancelled' : 'finished'}): {runProgressLabel(latestDone)}. Tokens in {formatTokens(latestDone.inputTokens)} / out {formatTokens(latestDone.outputTokens)}.
        </p>
      )}

      <ConfirmDialog
        open={evaluating}
        onOpenChange={(o) => !o && closeEvaluate()}
        title="Evaluate with AI"
        variant="default"
        confirmLabel="Start evaluation"
        isPending={start.isPending}
        onConfirm={() => start.mutate({ jobRoleId, force }, { onSuccess: closeEvaluate })}
        description={
          <>
            <p>
              About {total} submission{total === 1 ? '' : 's'} match the current filters. The AI will grade the submitted answers of this role,
              which sends their text (without names or academics) to OpenAI. It only suggests marks; a person confirms them.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox id="ai-force" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <Label htmlFor="ai-force">Re-grade answers that already have an AI score</Label>
            </div>
            {start.isError && <ErrorText error={start.error} />}
          </>
        }
      />

      <Dialog open={accepting} onOpenChange={(o) => !o && !accept.isPending && closeAccept()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Bulk accept AI marks</DialogTitle>
            <DialogDescription>
              Saves the AI marks as your marks and submits those evaluations. Scripts that are not safe to accept are skipped for individual review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-4">
            {!accept.data && (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Which submissions</legend>
                  <div className="flex items-center gap-2">
                    <input type="radio" id="ba-sel" name="ba-scope" className="accent-primary" checked={scope === 'selected'} disabled={selectedIds.length === 0} onChange={() => setScope('selected')} />
                    <Label htmlFor="ba-sel">Selected rows ({selectedIds.length})</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="radio" id="ba-role" name="ba-scope" className="accent-primary" checked={scope === 'role'} disabled={!jobRoleId} onChange={() => setScope('role')} />
                    <Label htmlFor="ba-role">The whole role{jobRoleId ? '' : ' (pick a role in the filter first)'}</Label>
                  </div>
                </fieldset>
                <div className="flex items-center gap-2">
                  <Checkbox id="ba-clean" checked={onlyClean} onChange={(e) => setOnlyClean(e.target.checked)} />
                  <Label htmlFor="ba-clean">Only clean scripts (no AI concerns, low confidence or integrity flags)</Label>
                </div>
                {accept.isError && <ErrorText error={accept.error} />}
              </>
            )}
            {accept.data && (
              <div aria-live="polite" className="space-y-2 text-sm">
                <p className="font-medium">{accept.data.accepted} accepted, {accept.data.skipped.length} skipped.</p>
                {accept.data.skipped.length > 0 && (
                  <>
                    <ul className="list-disc pl-5">
                      {summariseSkips(accept.data.skipped).map((s) => <li key={s.reason}>{s.label}: {s.count}</li>)}
                    </ul>
                    <p className="text-xs text-muted-foreground">Skipped scripts: {accept.data.skipped.map((s) => s.candidateCode ?? 'unknown').join(', ')}</p>
                  </>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            {accept.data ? (
              <Button onClick={() => { closeAccept(); onClearSelection(); }}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeAccept} disabled={accept.isPending}>Cancel</Button>
                <Button
                  disabled={accept.isPending || (!useSelected && !jobRoleId)}
                  onClick={() => accept.mutate(useSelected ? { attemptIds: selectedIds, onlyClean } : { jobRoleId, onlyClean })}
                >
                  {accept.isPending ? 'Accepting…' : 'Accept AI marks'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
