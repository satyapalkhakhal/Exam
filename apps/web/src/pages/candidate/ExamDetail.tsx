// src/pages/candidate/ExamDetail.tsx
// Why: the start page for ONE application (design 7.3; /exams/:applicationId, formerly the
// candidate dashboard). Everything is scoped to the application in the URL. Start stays disabled until the exam is
// open, location is captured (or exempt) and the instructions are acknowledged. Clicking
// Start re-captures location, and if the server still says LOCATION_REQUIRED the same
// alert re-opens inline, so a candidate who switched location off after login is asked again.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, MapPinOff } from 'lucide-react';
import { ArihantPlusStrip } from '@/components/auth/ArihantPlusBanner';
import { CandidateNavBar } from '@/components/layout/CandidateNavBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LocationHelp } from '@/components/location/LocationHelp';
import { useCandidateExam, useCandidateExams, useResumeExam, useStartExam } from '@/api/candidate/exam';
import { ApiError } from '@/lib/api';
import { examTitle } from '@/lib/submissionReceipt';
import { currentUa } from '@/lib/browserInfo';
import { examAvailability } from '@exam/shared';
import { requestLocation, watchPermission } from '@/lib/geolocation';
import { initialStartFlow, startFlowReducer } from '@/lib/startFlow';
import { useRecordLocation } from '@/api/candidate/location';
import { formatIst } from '@/lib/istTime';
import { createServerClock } from '@/lib/serverClock';
import { examPaths } from '@/lib/examSections';
import { negativeMarkingText } from '@/lib/examMcq';
import { useCandidateAuth } from '@/stores/candidateAuth';

const ANOTHER_EXAM_MESSAGE = 'You already have another exam in progress. Finish and submit it before starting this one.';

const RULES = [
  'Pasting, copying and dropping text into the answer box is blocked, and every attempt is recorded.',
  'Your activity during the exam (tab switches, going offline) is recorded.',
  'The timer keeps running if you close the tab or lose connection.',
  'Your exam is submitted automatically when time is up.',
];

export default function CandidateExamDetail() {
  const { applicationId = '' } = useParams();
  const navigate = useNavigate();
  const candidate = useCandidateAuth((s) => s.candidate);
  const detail = useCandidateExam(applicationId);
  const exam = detail.data?.exam;
  const start = useStartExam(applicationId);
  const resume = useResumeExam(applicationId);
  const [read, setRead] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const others = useCandidateExams();
  const otherInProgress = blocked ? others.data?.exams.find((x) => x.progress === 'IN_PROGRESS' && x.applicationId !== applicationId) : undefined;
  const [flow, dispatch] = useReducer(startFlowReducer, initialStartFlow);
  const { locating, alert, error: startError } = flow;
  const record = useRecordLocation();
  const recordRef = useRef(record.mutateAsync);
  recordRef.current = record.mutateAsync;
  const retrying = useRef(false);
  const [tick, setTick] = useState(0);

  // Re-evaluate the window now and then so the button opens without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const availability = useMemo(() => {
    if (!detail.data) return null;
    const clock = createServerClock(detail.data.serverNow, detail.dataUpdatedAt);
    return examAvailability(detail.data.exam, new Date(clock.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data, detail.dataUpdatedAt, tick]);

  // Re-ask after LOCATION_REQUIRED: capture again, record it (LOGIN stage is what unlocks Start) and recover.
  const retryLocation = useCallback(async () => {
    if (retrying.current) return;
    retrying.current = true;
    dispatch({ type: 'begin' });
    try {
      const result = await requestLocation();
      if (result.permission !== 'GRANTED') {
        try {
          await recordRef.current({ ...result, stage: 'LOGIN' });
        } catch {
          /* best effort for failures */
        }
        dispatch({ type: 'locationProblem', permission: result.permission });
        return;
      }
      const meta = await recordRef.current({ ...result, stage: 'LOGIN' });
      if (meta.locationCaptured === false) {
        dispatch({ type: 'locationProblem', permission: 'UNAVAILABLE' });
        return;
      }
      const c = useCandidateAuth.getState().candidate;
      if (c) useCandidateAuth.getState().setCandidate({ ...c, locationCaptured: true });
      dispatch({ type: 'recovered' });
    } catch {
      dispatch({ type: 'saveFailed' });
    } finally {
      retrying.current = false;
    }
  }, []);

  const alertShown = alert !== null;
  useEffect(() => {
    if (!alertShown) return;
    return watchPermission((state) => {
      if (state === 'granted') void retryLocation();
    });
  }, [alertShown, retryLocation]);

  if (!candidate) return null;
  if (detail.error instanceof ApiError && (detail.error.code === 'NOT_FOUND' || detail.error.status === 404)) {
    return <Navigate to="/dashboard" replace />;
  }
  if (exam?.progress === 'SUBMITTED') return <Navigate to={examPaths.submitted(applicationId)} replace />;

  const inProgress = exam?.progress === 'IN_PROGRESS';
  const locationOk = candidate.locationCaptured || candidate.locationExempt || Boolean(exam?.locationExempt);

  const availabilityReason: Record<string, string> = {
    NOT_OPEN: 'The exam is not open yet.',
    BEFORE_WINDOW: exam?.windowStart ? `The exam opens on ${formatIst(exam.windowStart)}.` : 'The exam is not open yet.',
    AFTER_WINDOW: 'The exam window has closed.',
  };
  let reason: string | null = null;
  if (!inProgress) {
    if (!exam || !availability) reason = 'Loading exam details…';
    else if (availability !== 'OPEN') reason = availabilityReason[availability] ?? null;
    else if (!locationOk) reason = 'Enable location to start your exam.';
    else if (!read) reason = 'Tick "I have read the instructions" to continue.';
  }
  const canStart = reason === null;
  const busy = locating || start.isPending || resume.isPending;

  const onStart = async () => {
    if (locating || start.isPending) return;
    dispatch({ type: 'begin' });
    const result = await requestLocation();
    start.mutate(
      { ...result, stage: 'EXAM_START' },
      {
        onSuccess: () => navigate(examPaths.take(applicationId)),
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'LOCATION_REQUIRED') {
            dispatch({ type: 'locationProblem', permission: result.permission === 'GRANTED' ? 'UNAVAILABLE' : result.permission });
            const c = useCandidateAuth.getState().candidate;
            if (c) useCandidateAuth.getState().setCandidate({ ...c, locationCaptured: false });
          } else if (e instanceof ApiError && e.code === 'ALREADY_ATTEMPTED') navigate(examPaths.submitted(applicationId));
          else if (e instanceof ApiError && e.code === 'ANOTHER_EXAM_IN_PROGRESS') {
            dispatch({ type: 'failed', message: ANOTHER_EXAM_MESSAGE });
            setBlocked(true);
            void detail.refetch();
          }
          else {
            if (e instanceof ApiError && (e.code === 'EXAM_NOT_OPEN' || e.code === 'EXAM_WINDOW_CLOSED')) void detail.refetch();
            dispatch({ type: 'failed', message: e instanceof ApiError ? e.message : 'Could not start the exam. Please try again.' });
          }
        },
      },
    );
  };

  const onResume = () =>
    resume.mutate(undefined, {
      onSuccess: () => navigate(examPaths.take(applicationId)),
      onError: (e) => dispatch({ type: 'failed', message: e instanceof ApiError ? e.message : 'Could not resume the exam. Please try again.' }),
    });

  const action = (
    <Button size="lg" className="w-full sm:w-auto" disabled={!canStart || busy} onClick={inProgress ? onResume : () => void onStart()}>
      {inProgress ? (resume.isPending ? 'Resuming…' : 'Resume Examination') : locating ? 'Checking location…' : start.isPending ? 'Starting…' : 'Start Examination'}
    </Button>
  );

  return (
    <div className="min-h-screen bg-background">
      <CandidateNavBar />

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Link to="/dashboard" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to my exams
        </Link>
        {!locationOk && !inProgress && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 font-semibold">
              <MapPinOff className="h-4 w-4 shrink-0" aria-hidden="true" /> Location required to start your exam
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/location">Enable location</Link>
            </Button>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Welcome, {candidate.fullName}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Candidate code</dt>
              <dd className="font-medium">{exam?.candidateCode ?? '…'}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium">{exam ? examTitle(exam) : '…'}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="font-medium">{exam ? `${exam.durationMinutes} minutes` : '…'}</dd>
              <dt className="text-muted-foreground">Exam window</dt>
              <dd className="font-medium">
                {exam
                  ? exam.windowStart || exam.windowEnd
                    ? `${formatIst(exam.windowStart)} to ${formatIst(exam.windowEnd)}`
                    : 'Open any time'
                  : '…'}
              </dd>
            </dl>
          </CardContent>
        </Card>

        {detail.isError && !(detail.error instanceof ApiError && detail.error.status === 404) && (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t load the exam details. <button className="underline" onClick={() => void detail.refetch()}>Retry</button>
          </p>
        )}

        {exam && exam.instructions.trim() && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Instructions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm">{exam.instructions}</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Exam rules</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {RULES.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {exam && negativeMarkingText(exam.mcqNegativeMarks) && (
                <li className="font-medium text-foreground">{negativeMarkingText(exam.mcqNegativeMarks)}</li>
              )}
            </ul>
          </CardContent>
        </Card>

        {alert && (
          <div className="space-y-3">
            {alert === 'SAVE_FAILED' ? (
              <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900">
                We couldn&apos;t save your location — check your connection and try again.
              </p>
            ) : (
              <LocationHelp permission={alert} userAgent={currentUa()} />
            )}
            <Button variant="outline" disabled={locating} onClick={() => void retryLocation()}>
              {locating ? 'Checking location…' : 'Try again'}
            </Button>
          </div>
        )}
        <div aria-live="polite">
          {startError && <p className="text-sm text-destructive">{startError}</p>}
          {otherInProgress && (
            <p className="mt-1 text-sm">
              <Link to={examPaths.detail(otherInProgress.applicationId)} className="text-primary underline">
                Go to your exam in progress ({examTitle(otherInProgress)})
              </Link>
            </p>
          )}
        </div>

        {!inProgress && (
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={read} onChange={(e) => setRead(e.target.checked)} />
            <span>I have read the instructions</span>
          </label>
        )}

        {canStart || busy ? (
          action
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-block w-full sm:w-auto" aria-describedby="start-reason">
                {action}
              </span>
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
          </Tooltip>
        )}
        {!canStart && (
          <p id="start-reason" className="text-xs text-muted-foreground" aria-live="polite">
            {reason}
          </p>
        )}

        {/* Below the Start button, so it never competes with starting the exam. */}
        <ArihantPlusStrip className="!mt-10" />
      </main>
    </div>
  );
}
