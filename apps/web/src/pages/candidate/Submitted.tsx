// src/pages/candidate/Submitted.tsx
// Why: the end of the candidate journey (design 7.6). A submission receipt the candidate can
// print or keep: who, which job profile, when it started and ended, manual or auto-submitted,
// how many questions were answered, the time taken, and whether the result is awaiting or
// declared. Still never marks, answers or the outcome itself.

import { Navigate } from 'react-router';
import { CheckCircle2, Printer } from 'lucide-react';
import { CandidateSignOut } from '@/components/layout/CandidateSignOut';
import { Button } from '@/components/ui/button';
import { useExamSummary } from '@/api/candidate/exam';
import { receiptRows } from '@/lib/submissionReceipt';
import { useCandidateAuth } from '@/stores/candidateAuth';

export default function CandidateSubmitted() {
  const candidate = useCandidateAuth((s) => s.candidate);
  const summary = useExamSummary();

  if (summary.data?.status === 'IN_PROGRESS') return <Navigate to="/exam" replace />;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md space-y-6 text-center">
        <img src="/logo-light.svg" alt="Arihant Capital" className="mx-auto h-10 w-auto" />

        <div className="space-y-2">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground">Exam submitted successfully</h1>
          <p className="text-sm text-muted-foreground">Thank you. Your answers have been saved.</p>
        </div>

        {summary.isPending && <p className="text-sm text-muted-foreground" role="status">Loading your receipt…</p>}

        {candidate && summary.data && (
          <section aria-label="Submission receipt" className="rounded-lg border border-border bg-card p-4 text-left">
            <dl className="divide-y divide-border text-sm">
              {receiptRows(candidate, summary.data).map((r) => (
                <div key={r.label} className="flex justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">{r.label}</dt>
                  <dd className="text-right font-medium text-foreground">{r.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <p className="text-sm text-muted-foreground">
          Your answers will be reviewed by our team, and HR will contact you about the next steps. You can close this window.
        </p>

        <div className="flex items-center justify-center gap-4 print:hidden">
          {summary.data && (
            <Button type="button" variant="outline" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Print / save receipt
            </Button>
          )}
          <CandidateSignOut />
        </div>
      </div>
    </div>
  );
}
