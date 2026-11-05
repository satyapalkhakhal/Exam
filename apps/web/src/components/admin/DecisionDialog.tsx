// src/components/admin/DecisionDialog.tsx
// Why: shortlist or reject one or many candidates (Candidates bulk action, Leaderboard
// row) and, by default, send the matching email in the same click. The server sets the
// result only for evaluated candidates and says who it skipped and why; emails go to
// those whose result changed (docs/superpowers/specs/2026-11-05-candidate-result-column-design.md).

import { useMemo, useState } from 'react';
import type { CandidateResult } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useEmailPreview } from '@/api/admin/emails';
import { useBulkDecision } from '@/api/admin/results';
import { EmailErrorNote } from '@/components/admin/EmailErrorNote';
import { EmailPreviewFrame } from '@/components/admin/EmailPreviewFrame';
import { NextRoundFields } from '@/components/admin/NextRoundFields';
import { EMPTY_NEXT_ROUND, decisionSkipLabel, decisionTitle, nextRoundLinkError, nextRoundPayload, skipReasonLabel } from '@/lib/emailTemplates';
import { useDebounced } from '@/lib/useDebounced';

const VERB: Record<CandidateResult, { title: string; done: string }> = {
  SHORTLISTED: { title: 'Shortlist', done: 'shortlisted' },
  REJECTED: { title: 'Reject', done: 'rejected' },
};


export function DecisionDialog({
  open,
  decision,
  candidateIds,
  jobProfileCount = 1,
  onClose,
  onDone,
}: {
  open: boolean;
  decision: CandidateResult;
  candidateIds: string[];
  /** Distinct job profiles in the selection; a line warns when it is more than one. */
  jobProfileCount?: number;
  onClose: () => void;
  /** Called after a successful decision so the page can clear its selection. */
  onDone?: () => void;
}) {
  const decide = useBulkDecision();
  const [comment, setComment] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [round, setRound] = useState(EMPTY_NEXT_ROUND);
  // How many were submitted: onDone clears the page selection while the summary is still open.
  const [submitted, setSubmitted] = useState(0);
  const shortlist = decision === 'SHORTLISTED';
  const nextRound = useMemo(() => (shortlist && sendEmail ? nextRoundPayload(round) : undefined), [shortlist, sendEmail, round]);
  const linkBad = shortlist && sendEmail && nextRoundLinkError(round.link) !== null;
  const debounced = useDebounced({ nextRound }, 400);
  const preview = useEmailPreview(decision, debounced, open && sendEmail && !linkBad);
  const result = decide.data;
  const n = candidateIds.length;
  const verb = VERB[decision];

  const close = () => {
    decide.reset();
    setComment('');
    setSendEmail(true);
    setRound(EMPTY_NEXT_ROUND);
    onClose();
  };

  const submit = () => {
    setSubmitted(n);
    decide.mutate(
      { candidateIds, decision, sendEmail, comment: comment.trim() || undefined, nextRound },
      { onSuccess: () => onDone?.() },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{decisionTitle(decision, result ? submitted : n)}</DialogTitle>
          <DialogDescription>
            {result
              ? 'Done. The list shows the new results.'
              : 'Only evaluated candidates can be decided; the others are skipped and listed afterwards.'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
          {result ? (
            <div className="space-y-3" aria-live="polite">
              <p className="text-sm">
                <strong>{result.updated}</strong> {verb.done}, <strong>{result.emailsQueued}</strong> email{result.emailsQueued === 1 ? '' : 's'} queued,{' '}
                <strong>{result.skipped.length}</strong> skipped.
              </p>
              {result.emailError && <p role="alert" className="text-sm text-destructive">{result.emailError}</p>}
              {result.skipped.length > 0 && (
                <SkipList title="Not changed" items={result.skipped.map((s) => ({ ...s, label: decisionSkipLabel(s.reason) }))} />
              )}
              {result.emailSkipped.length > 0 && (
                <SkipList title="Result saved, but no email sent" items={result.emailSkipped.map((s) => ({ ...s, label: skipReasonLabel(s.reason) }))} />
              )}
            </div>
          ) : (
            <>
              {jobProfileCount > 1 && (
                <p className="rounded-md border border-border bg-muted p-3 text-sm" role="status">
                  Selection covers {jobProfileCount} job profiles.
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="dd-comment">Comment (optional)</Label>
                <Textarea id="dd-comment" value={comment} maxLength={500} rows={2} onChange={(e) => setComment(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
                Also send the email
              </label>
              {sendEmail && (
                <>
                  {shortlist && <NextRoundFields idPrefix="dd" value={round} onChange={setRound} />}
                  <div>
                    <p className="mb-1 text-sm font-medium">Preview (sample data)</p>
                    <EmailPreviewFrame
                      subject={preview.data?.subject}
                      html={preview.data?.html}
                      loading={preview.isFetching}
                      error={preview.error && !preview.data ? preview.error.message : undefined}
                    />
                  </div>
                </>
              )}
              <EmailErrorNote error={decide.error} />
            </>
          )}
          <DialogFooter>
            {result ? (
              <Button type="button" onClick={close}>Done</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={close}>Cancel</Button>
                <Button
                  type="button"
                  variant={shortlist ? 'default' : 'destructive'}
                  disabled={n === 0 || linkBad || decide.isPending}
                  onClick={submit}
                >
                  {decide.isPending ? 'Saving…' : `${verb.title} ${n}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkipList({ title, items }: { title: string; items: { candidateId: string; candidateCode: string | null; fullName: string | null; label: string }[] }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{title}</p>
      <ul className="max-h-60 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
        {items.map((s) => (
          <li key={s.candidateId} className="flex justify-between gap-3">
            <span>{s.fullName ?? 'Unknown'} <span className="font-mono text-xs text-muted-foreground">{s.candidateCode ?? ''}</span></span>
            <span className="text-muted-foreground">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
