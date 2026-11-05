// src/pages/admin/Marking.tsx
// Why: marks one script (design §8). Opening takes the soft lock (423 -> read-only, naming
// the holder), renewed every 10 minutes while the page is open, and released on unmount and
// on pagehide (keepalive DELETE through apiFetch, since sendBeacon cannot DELETE). Drafts are
// seeded from a fetch made after the lock settled, never from an older cached copy. The server is blind-marking: an Evaluator's payload has no PII,
// so the candidate panel renders only for a Super Admin. Marks are validated client-side with
// the same rules as the server's validateMarks; the server remains authoritative.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { AdminRole } from '@exam/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ReasonDialog } from '@/components/admin/ReasonDialog';
import { ExamTimeline } from '@/components/admin/ExamTimeline';
import { ApiError } from '@/lib/api';
import { createLockManager, LOCK_RENEW_MS } from '@/lib/lockManager';
import { canSubmitEvaluation, shouldSeedDrafts, sumMarks, validateMarksClient } from '@/lib/marking';
import {
  lockAttempt,
  markingKey,
  releaseLock,
  useMarkingView,
  useReopen,
  useSaveEvaluation,
  type EvaluationItem,
  type MarkingQuestion,
} from '@/api/admin/evaluation';
import { useAdminAuth } from '@/stores/adminAuth';

interface Draft {
  marks: string;
  comment: string;
}

const locks = createLockManager({ post: lockAttempt, del: releaseLock });

const parseMarks = (s: string): number | null => (s.trim() === '' ? null : Number(s));

function lockHolder(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { lockedBy?: { name?: string } } | undefined;
    return d?.lockedBy?.name ?? e.message;
  }
  return 'another evaluator';
}

function QuestionPanel({ q, draft, readOnly, onChange }: { q: MarkingQuestion; draft: Draft; readOnly: boolean; onChange: (d: Draft) => void }) {
  const err = draft.marks.trim() === '' ? null : validateMarksClient(Number(draft.marks), q.maxMarks);
  const { pasteAttempts, bulkInsert } = q.integrity;
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label={`Question ${q.order}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Q{q.order}. <span className="whitespace-pre-wrap font-normal">{q.text}</span></h2>
        <Badge variant="outline">{q.maxMarks} marks</Badge>
      </div>
      {q.evaluatorGuidance && (
        <div className="rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">Evaluator guidance</div>
          <p className="whitespace-pre-wrap">{q.evaluatorGuidance}</p>
        </div>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Answer</span>
          <span>{q.answer.wordCount} words</span>
        </div>
        <div tabIndex={0} aria-label={`Answer to question ${q.order}`} className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-sm select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {q.answer.text || <span className="text-muted-foreground">No answer.</span>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={pasteAttempts > 0 ? 'destructive' : 'outline'}>Paste attempts: {pasteAttempts}</Badge>
        <Badge variant={bulkInsert.length > 0 ? 'destructive' : 'outline'}>Bulk inserts: {bulkInsert.length}</Badge>
        {bulkInsert.map((b, i) => (
          <span key={i} className="text-muted-foreground">
            {new Date(b.at).toLocaleTimeString()}: +{b.grown} chars, typed {b.typed}
          </span>
        ))}
      </div>
      {q.answer.versions.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Version timeline ({q.answer.versions.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {q.answer.versions.map((v, i) => (
              <li key={i}>{new Date(v.savedAt).toLocaleTimeString()}: {v.wordCount} words</li>
            ))}
          </ul>
        </details>
      )}
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`marks-${q.attemptQuestionId}`}>Marks (max {q.maxMarks})</Label>
          <Input
            id={`marks-${q.attemptQuestionId}`}
            type="number"
            step={0.5}
            min={0}
            max={q.maxMarks}
            inputMode="decimal"
            disabled={readOnly}
            value={draft.marks}
            aria-invalid={Boolean(err)}
            onChange={(e) => onChange({ ...draft, marks: e.target.value })}
          />
          {err && <p className="text-xs text-destructive" role="alert">{err}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`comment-${q.attemptQuestionId}`}>Comment</Label>
          <Textarea id={`comment-${q.attemptQuestionId}`} rows={2} disabled={readOnly} value={draft.comment} onChange={(e) => onChange({ ...draft, comment: e.target.value })} />
        </div>
      </div>
    </section>
  );
}

export default function Marking() {
  const { attemptId = '' } = useParams();
  const isSa = useAdminAuth((s) => s.admin?.role) === AdminRole.SUPER_ADMIN;
  const view = useMarkingView(attemptId);
  const save = useSaveEvaluation(attemptId);
  const reopen = useReopen(attemptId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [lockSettledAt, setLockSettledAt] = useState<number | null>(null);
  const qc = useQueryClient();
  /** True while this page holds the lock; only then does it renew it. */
  const held = useRef(false);

  useEffect(() => {
    if (!attemptId) return;
    const { token, result } = locks.acquire(attemptId);
    held.current = false;
    result
      .then(() => {
        held.current = true;
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'EVALUATION_LOCKED') setLockedBy(lockHolder(e));
        else setLockError(e instanceof Error ? e.message : 'Could not lock this attempt');
      })
      .finally(() => {
        // Seed only from data read now, after the lock: see shouldSeedDrafts.
        setLockSettledAt(Date.now());
        void qc.refetchQueries({ queryKey: markingKey(attemptId) });
      });
    const renewal = window.setInterval(() => {
      if (!held.current) return;
      locks.renew(attemptId, token)?.catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'EVALUATION_LOCKED') {
          held.current = false;
          setLockedBy(lockHolder(e));
        }
      });
    }, LOCK_RENEW_MS);
    const onHide = () => locks.releaseNow(attemptId, token);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(renewal);
      held.current = false;
      window.removeEventListener('pagehide', onHide);
      locks.release(attemptId, token);
    };
  }, [attemptId, qc]);

  useEffect(() => {
    if (!view.data || !shouldSeedDrafts({ seeded, lockSettledAt, dataUpdatedAt: view.dataUpdatedAt, isFetching: view.isFetching })) return;
    setSeeded(true);
    setDrafts(
      Object.fromEntries(
        view.data.questions.map((q) => [q.attemptQuestionId, { marks: q.evaluation.marks === null ? '' : String(q.evaluation.marks), comment: q.evaluation.comment ?? '' }]),
      ),
    );
  }, [view.data, view.dataUpdatedAt, view.isFetching, seeded, lockSettledAt]);

  if (view.isPending) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (view.error || !view.data) return <p className="text-sm text-destructive" role="alert">{view.error?.message ?? 'Could not load this submission.'}</p>;

  const v = view.data;
  const finalised = v.evaluationStatus === 'SUBMITTED';
  // Until fresh drafts are seeded the inputs are empty; saving then would wipe stored marks.
  const readOnly = lockedBy !== null || lockError !== null || finalised || !seeded;
  const rows = v.questions.map((q) => ({ q, marks: parseMarks(drafts[q.attemptQuestionId]?.marks ?? '') }));
  const invalid = rows.some(({ q, marks }) => marks !== null && validateMarksClient(marks, q.maxMarks) !== null);
  const max = v.questions.reduce((t, q) => t + q.maxMarks, 0);
  const items: EvaluationItem[] = v.questions.map((q) => {
    const d = drafts[q.attemptQuestionId];
    return { attemptQuestionId: q.attemptQuestionId, marks: parseMarks(d?.marks ?? ''), comment: d?.comment ?? '' };
  });

  // If the server says the lock is no longer ours (e.g. it expired or a stray release landed),
  // take it again once and retry the save before surfacing an error.
  const run = async (submit: boolean) => {
    setNotice(null);
    try {
      try {
        await save.mutateAsync({ items, submit });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'EVALUATION_LOCKED') throw e;
        try {
          await lockAttempt(attemptId);
          held.current = true;
        } catch (le) {
          setLockedBy(lockHolder(le));
          return;
        }
        await save.mutateAsync({ items, submit });
      }
      setNotice(submit ? 'Evaluation submitted.' : 'Draft saved.');
    } catch {
      // surfaced through save.error
    }
  };
  const saveError = save.error instanceof ApiError ? save.error.message : save.error ? 'Could not save.' : null;

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/admin/submissions" className="text-xs text-primary hover:underline">Back to submissions</Link>
          <h1 className="text-xl font-semibold text-foreground">
            <span className="font-mono">{v.candidateCode}</span> <span className="text-base font-normal text-muted-foreground">{v.jobRole}</span>
          </h1>
        </div>
        {isSa && finalised && <Button variant="outline" onClick={() => setReopening(true)}>Reopen</Button>}
      </div>

      {lockedBy && <p className="rounded-md border border-border bg-muted p-3 text-sm" role="status">Being marked by {lockedBy}. This view is read-only.</p>}
      {lockError && <p className="text-sm text-destructive" role="alert">{lockError}</p>}
      {finalised && <p className="rounded-md border border-border bg-muted p-3 text-sm" role="status">This evaluation is submitted{isSa ? '; reopen it to change marks.' : '.'}</p>}

      {isSa && v.fullName !== undefined && (
        <section className="grid gap-2 rounded-lg border border-border bg-card p-4 text-sm sm:grid-cols-3" aria-label="Candidate">
          <div><span className="text-muted-foreground">Name</span><div className="font-medium">{v.fullName}</div></div>
          <div><span className="text-muted-foreground">Email</span><div>{v.email}</div></div>
          <div><span className="text-muted-foreground">Roll number</span><div>{v.rollNumber ?? '-'}</div></div>
          <div><span className="text-muted-foreground">X % / XII %</span><div>{v.xPercentage ?? '-'} / {v.xiiPercentage ?? '-'}</div></div>
          <div><span className="text-muted-foreground">CPI</span><div>{v.majorCpi ?? '-'}</div></div>
          <div><span className="text-muted-foreground">Programme</span><div>{[v.programme, v.discipline].filter(Boolean).join(', ') || '-'}</div></div>
        </section>
      )}

      <ExamTimeline events={v.timeline} startedAt={v.startedAt} />

      {v.questions.map((q) => (
        <QuestionPanel
          key={q.attemptQuestionId}
          q={q}
          readOnly={readOnly}
          draft={drafts[q.attemptQuestionId] ?? { marks: '', comment: '' }}
          onChange={(d) => setDrafts((c) => ({ ...c, [q.attemptQuestionId]: d }))}
        />
      ))}

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-4 py-3 backdrop-blur lg:left-60">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-semibold">Total: {sumMarks(rows)}</span> <span className="text-muted-foreground">/ {max}</span>
            <span className="ml-3 text-xs" role="status" aria-live="polite">{saveError ? <span className="text-destructive">{saveError}</span> : notice}</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={readOnly || invalid || save.isPending} onClick={() => void run(false)}>Save draft</Button>
            <Button disabled={readOnly || invalid || save.isPending || !canSubmitEvaluation(rows)} onClick={() => void run(true)}>Submit evaluation</Button>
          </div>
        </div>
      </div>

      <ReasonDialog
        open={reopening}
        onOpenChange={setReopening}
        title="Reopen evaluation"
        description="The evaluation goes back to draft and the candidate returns to their previous status. If this candidate was shortlisted or rejected, that result is cleared. Emails already sent are not recalled. This is logged."
        label="Reason"
        required
        confirmLabel="Reopen"
        isPending={reopen.isPending}
        error={reopen.error?.message}
        onSubmit={(reason) =>
          reopen.mutate(reason, {
            onSuccess: () => {
              setReopening(false);
              setLockSettledAt(Date.now());
              setSeeded(false);
              void view.refetch();
            },
          })
        }
      />
    </div>
  );
}
