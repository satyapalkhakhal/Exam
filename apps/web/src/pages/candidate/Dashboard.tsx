// src/pages/candidate/Dashboard.tsx
// Why: "My exams" (docs/multi-exam.md). A person may hold several applications, one per job
// role; HR enrols them and the candidate only opens, starts or resumes. Sections come from the
// pure groupExams() judged on the server clock, so a device with a wrong clock sees the right
// state. The location banner stays here because LOGIN-stage location is account-wide.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { MapPinOff } from 'lucide-react';
import type { CandidateExamDto } from '@exam/shared';
import { ArihantPlusStrip } from '@/components/auth/ArihantPlusBanner';
import { CandidateSignOut } from '@/components/layout/CandidateSignOut';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useCandidateExams } from '@/api/candidate/exam';
import { examPaths, groupExams } from '@/lib/examSections';
import { examTitle } from '@/lib/submissionReceipt';
import { formatIst } from '@/lib/istTime';
import { createServerClock } from '@/lib/serverClock';
import { useCandidateAuth } from '@/stores/candidateAuth';

function ExamRow({ exam, action, note }: { exam: CandidateExamDto; action: { label: string; to: string }; note: string }) {
  return (
    <li>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5">
            <h3 className="truncate text-base font-semibold">{examTitle(exam)}</h3>
            <p className="text-xs text-muted-foreground">
              {exam.candidateCode} · {exam.durationMinutes} minutes
            </p>
            <p className="text-sm text-muted-foreground">{note}</p>
          </div>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link to={action.to} aria-label={`${action.label}: ${examTitle(exam)}`}>
              {action.label}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (children.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

export default function CandidateDashboard() {
  const candidate = useCandidateAuth((s) => s.candidate);
  const list = useCandidateExams();
  const [tick, setTick] = useState(0);

  // Re-evaluate windows now and then so "Upcoming" becomes "Available" without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const sections = useMemo(() => {
    if (!list.data) return null;
    const clock = createServerClock(list.data.serverNow, list.dataUpdatedAt);
    return groupExams(list.data.exams, clock.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, list.dataUpdatedAt, tick]);

  if (!candidate) return null;
  const locationOk = candidate.locationCaptured || candidate.locationExempt;
  const opens = (e: CandidateExamDto) => (e.windowStart ? `Opens ${formatIst(e.windowStart)}` : 'Not open yet');

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <img src="/logo-light.svg" alt="Arihant Capital" className="h-8 w-auto" />
          <div className="flex items-center gap-4">
            <p className="hidden text-right text-sm text-muted-foreground sm:block">
              <span className="block font-medium text-foreground">{candidate.fullName}</span>
              {candidate.email}
            </p>
            <CandidateSignOut />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-semibold">My exams</h1>

        {!locationOk && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 font-semibold">
              <MapPinOff className="h-4 w-4 shrink-0" aria-hidden="true" /> Location required to start your exam
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/location">Enable location</Link>
            </Button>
          </div>
        )}

        {list.isPending && <p className="text-sm text-muted-foreground" role="status">Loading your exams…</p>}
        {list.isError && (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t load your exams. <button className="underline" onClick={() => void list.refetch()}>Retry</button>
          </p>
        )}

        {list.data && list.data.exams.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No exams have been assigned to you yet. HR will enrol you; check back later.
            </CardContent>
          </Card>
        )}

        {sections && (
          <>
            <Section title="In progress">
              {sections.inProgress.map((e) => (
                <ExamRow key={e.applicationId} exam={e} action={{ label: 'Resume', to: examPaths.detail(e.applicationId) }} note="Your timer is running." />
              ))}
            </Section>
            <Section title="Available now">
              {sections.available.map((e) => (
                <ExamRow
                  key={e.applicationId}
                  exam={e}
                  action={{ label: 'Open', to: examPaths.detail(e.applicationId) }}
                  note={e.windowEnd ? `Open until ${formatIst(e.windowEnd)}` : 'Open now'}
                />
              ))}
            </Section>
            <Section title="Upcoming">
              {sections.upcoming.map((e) => (
                <ExamRow key={e.applicationId} exam={e} action={{ label: 'View details', to: examPaths.detail(e.applicationId) }} note={opens(e)} />
              ))}
            </Section>
            <Section title="Closed / not open">
              {sections.closed.map((e) => (
                <ExamRow
                  key={e.applicationId}
                  exam={e}
                  action={{ label: 'View details', to: examPaths.detail(e.applicationId) }}
                  note={e.isOpen ? 'The exam window has closed.' : 'This exam is not open.'}
                />
              ))}
            </Section>
            <Section title="Completed">
              {sections.completed.map((e) => (
                <ExamRow
                  key={e.applicationId}
                  exam={e}
                  action={{ label: 'View receipt', to: examPaths.submitted(e.applicationId) }}
                  note={e.attempt?.submittedAt ? `Submitted ${formatIst(e.attempt.submittedAt)}` : 'Submitted'}
                />
              ))}
            </Section>
          </>
        )}

        <ArihantPlusStrip className="!mt-10" />
      </main>
    </div>
  );
}
