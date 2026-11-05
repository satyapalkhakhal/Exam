// src/pages/candidate/Submitted.tsx
// Why: the end of the candidate journey (design 7.6). A submission receipt the candidate can
// print or keep: who, which job profile, when it started and ended, manual or auto-submitted,
// how many questions were answered, the time taken, and whether the result is awaiting or
// declared. Still never marks, answers or the outcome itself.

import { Link, Navigate, useParams } from 'react-router';
import { CheckCircle2, Printer } from 'lucide-react';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { CandidateSignOut } from '@/components/layout/CandidateSignOut';
import { Button } from '@/components/ui/button';
import { useCandidateExam, useExamSummary } from '@/api/candidate/exam';
import { receiptRows } from '@/lib/submissionReceipt';
import { examPaths } from '@/lib/examSections';
import { useCandidateAuth } from '@/stores/candidateAuth';

export default function CandidateSubmitted() {
  const candidate = useCandidateAuth((s) => s.candidate);
  const { applicationId = '' } = useParams();
  const summary = useExamSummary(applicationId);
  const detail = useCandidateExam(applicationId);
  const exam = detail.data?.exam;

  if (summary.data?.status === 'IN_PROGRESS') return <Navigate to={examPaths.take(applicationId)} replace />;
  if (summary.isError || detail.isError) return <Navigate to="/dashboard" replace />;

  return (
    // Same split as the login page: ArihantPlus panel on the left half from lg up, below the
    // receipt on phones. Printing drops the panel and the split, so the receipt prints alone.
    <div className="flex min-h-screen flex-col bg-background lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] print:block">
      <div className="flex flex-col items-center justify-center px-4 py-10 lg:order-2 lg:min-h-screen">
        <div className="w-full max-w-md space-y-6 text-center">
          <img src="/logo-light.svg" alt="Arihant Capital" className="mx-auto h-10 w-auto" />

          <div className="space-y-2">
            <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
            <h1 className="text-xl font-semibold text-foreground">Exam submitted successfully</h1>
            <p className="text-sm text-muted-foreground">Thank you. Your answers have been saved.</p>
          </div>

          {summary.isPending && <p className="text-sm text-muted-foreground" role="status">Loading your receipt…</p>}

          {candidate && exam && summary.data && (
            <section aria-label="Submission receipt" className="rounded-lg border border-border bg-card p-4 text-left">
              <dl className="divide-y divide-border text-sm">
                {receiptRows({ fullName: candidate.fullName, email: candidate.email, candidateCode: exam.candidateCode, jobRole: exam.jobRole, status: exam.progress }, summary.data).map((r) => (
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
            <Button asChild variant="outline">
              <Link to="/dashboard">Back to my exams</Link>
            </Button>
            <CandidateSignOut />
          </div>
        </div>
      </div>
      <div className="lg:order-1 print:hidden">
        <ArihantPlusBanner />
      </div>
    </div>
  );
}
