// src/pages/candidate/Dashboard.tsx
// Why: the candidate's landing page (design 7.3). Start stays disabled until the exam is
// open, location is captured (or exempt) and the instructions are acknowledged. Clicking
// Start re-captures location, and if the server still says LOCATION_REQUIRED the same
// alert re-opens inline, so a candidate who switched location off after login is asked again.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { MapPinOff } from 'lucide-react';
import { CandidateSignOut } from '@/components/layout/CandidateSignOut';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LocationHelp } from '@/components/location/LocationHelp';
import { useExamInfo, useResumeExam, useStartExam } from '@/api/candidate/exam';
import { ApiError } from '@/lib/api';
import { currentUa } from '@/lib/browserInfo';
import { examAvailability } from '@exam/shared';
import { requestLocation, watchPermission } from '@/lib/geolocation';
import { initialStartFlow, startFlowReducer } from '@/lib/startFlow';
import { useRecordLocation } from '@/api/candidate/location';
import { formatIst } from '@/lib/istTime';
import { createServerClock } from '@/lib/serverClock';
import { useCandidateAuth } from '@/stores/candidateAuth';

const SUBMITTED = new Set(['SUBMITTED', 'AUTO_SUBMITTED', 'EVALUATED', 'SHORTLISTED', 'REJECTED']);

const RULES = [
  'Pasting, copying and dropping text into the answer box is blocked, and every attempt is recorded.',
  'Your activity during the exam (tab switches, going offline) is recorded.',
  'The timer keeps running if you close the tab or lose connection.',
  'Your exam is submitted automatically when time is up.',
];

export default function CandidateDashboard() {
  const navigate = useNavigate();
  const candidate = useCandidateAuth((s) => s.candidate);
  const info = useExamInfo();
  const start = useStartExam();
  const resume = useResumeExam();
  const [read, setRead] = useState(false);
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
    if (!info.data) return null;
    const clock = createServerClock(info.data.serverNow, info.dataUpdatedAt);
    return examAvailability(info.data, new Date(clock.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.data, info.dataUpdatedAt, tick]);

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
  if (SUBMITTED.has(candidate.status)) return <Navigate to="/submitted" replace />;

  const inProgress = candidate.status === 'IN_PROGRESS';
  const locationOk = candidate.locationCaptured || candidate.locationExempt;

  const availabilityReason: Record<string, string> = {
    NOT_OPEN: 'The exam is not open yet.',
    BEFORE_WINDOW: info.data?.windowStart ? `The exam opens on ${formatIst(info.data.windowStart)}.` : 'The exam is not open yet.',
    AFTER_WINDOW: 'The exam window has closed.',
  };
  let reason: string | null = null;
  if (!inProgress) {
    if (!info.data || !availability) reason = 'Loading exam details…';
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
        onSuccess: () => navigate('/exam'),
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'LOCATION_REQUIRED') {
            dispatch({ type: 'locationProblem', permission: result.permission === 'GRANTED' ? 'UNAVAILABLE' : result.permission });
            const c = useCandidateAuth.getState().candidate;
            if (c) useCandidateAuth.getState().setCandidate({ ...c, locationCaptured: false });
          } else if (e instanceof ApiError && e.code === 'ALREADY_ATTEMPTED') navigate('/submitted');
          else {
            if (e instanceof ApiError && (e.code === 'EXAM_NOT_OPEN' || e.code === 'EXAM_WINDOW_CLOSED')) void info.refetch();
            dispatch({ type: 'failed', message: e instanceof ApiError ? e.message : 'Could not start the exam. Please try again.' });
          }
        },
      },
    );
  };

  const onResume = () =>
    resume.mutate(undefined, {
      onSuccess: () => navigate('/exam'),
      onError: (e) => dispatch({ type: 'failed', message: e instanceof ApiError ? e.message : 'Could not resume the exam. Please try again.' }),
    });

  const action = (
    <Button size="lg" className="w-full sm:w-auto" disabled={!canStart || busy} onClick={inProgress ? onResume : () => void onStart()}>
      {inProgress ? (resume.isPending ? 'Resuming…' : 'Resume Examination') : locating ? 'Checking location…' : start.isPending ? 'Starting…' : 'Start Examination'}
    </Button>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <img src="/logo-light.svg" alt="Arihant Capital" className="h-8 w-auto" />
          <div className="flex items-center gap-4">
            <p className="text-sm text-muted-foreground">Recruitment Assessment</p>
            <CandidateSignOut />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
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
              <dd className="font-medium">{candidate.candidateCode}</dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium">{candidate.jobRole.name}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="font-medium">{info.data ? `${info.data.durationMinutes} minutes` : '…'}</dd>
              <dt className="text-muted-foreground">Exam window</dt>
              <dd className="font-medium">
                {info.data
                  ? info.data.windowStart || info.data.windowEnd
                    ? `${formatIst(info.data.windowStart)} to ${formatIst(info.data.windowEnd)}`
                    : 'Open any time'
                  : '…'}
              </dd>
            </dl>
          </CardContent>
        </Card>

        {info.isError && (
          <p role="alert" className="text-sm text-destructive">
            Couldn&apos;t load the exam details. <button className="underline" onClick={() => void info.refetch()}>Retry</button>
          </p>
        )}

        {info.data && info.data.instructions.trim() && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Instructions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-line text-sm">{info.data.instructions}</p>
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
        <div aria-live="polite">{startError && <p className="text-sm text-destructive">{startError}</p>}</div>

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
      </main>
    </div>
  );
}
