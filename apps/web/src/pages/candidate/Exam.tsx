// src/pages/candidate/Exam.tsx
// Why: the exam screen (design 7.4-7.6). The rules that matter most live in src/lib and are
// tested there: autosave (never lose text), pasteGuard (block + record), serverClock (server
// time is authoritative). This page wires them to the browser: it resolves the attempt
// session (same tab keeps it, a new tab takes over), restores unsaved text from storage,
// batches activity events, and runs the time-up and submit flows. The server's auto-submit is
// the real deadline; the client only flushes what it has and gets out of the way.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Flag } from 'lucide-react';
import { countWords } from '@exam/shared';
import { Button } from '@/components/ui/button';
import { AnswerBox } from '@/components/exam/AnswerBox';
import { ExamHeader } from '@/components/exam/ExamHeader';
import { QuestionPalette, type PaletteItem } from '@/components/exam/QuestionPalette';
import { SubmitDialog } from '@/components/exam/SubmitDialog';
import {
  beaconAnswer,
  beaconEvents,
  forgetSession,
  getExamState,
  useCandidateExam,
  useInvalidateExams,
  postEvents,
  readSessionId,
  resumeExam,
  saveAnswer,
  submitExam,
} from '@/api/candidate/exam';
import { ApiError } from '@/lib/api';
import { createAutosaver, readMirror, shouldRestoreMirror, type Autosaver, type MirrorStorage, type SaveStatus } from '@/lib/autosave';
import { createEventQueue, type ExamEventType } from '@/lib/eventQueue';
import { attachPasteGuard, type BlockedKind } from '@/lib/pasteGuard';
import { createExamLifecycle, type ExamLifecycle, type LifecyclePhase } from '@/lib/examLifecycle';
import { createServerClock, type ServerClock } from '@/lib/serverClock';
import { tabPresenceFor } from '@/lib/tabPresence';
import { cn } from '@/lib/utils';
import { useCandidateAuth } from '@/stores/candidateAuth';
import { examPaths } from '@/lib/examSections';
import type { ExamState } from '@/types/exam';

interface Boot {
  state: ExamState;
  sessionId: string;
  receivedAt: number;
}

const bootKey = (applicationId: string) => ['candidate', 'exam', 'boot', applicationId] as const;
const BLOCKED_TOAST = 'Pasting, copying and dragging text are disabled during the exam. This attempt has been recorded.';
const TIME_UP = 'Time is up — your answers have been submitted';
const BLOCKED_EVENT: Record<BlockedKind, ExamEventType> = {
  PASTE: 'PASTE_ATTEMPT',
  COPY: 'COPY_ATTEMPT',
  CUT: 'CUT_ATTEMPT',
  DROP: 'DROP_ATTEMPT',
  CONTEXT_MENU: 'CONTEXT_MENU',
};

async function bootExam(applicationId: string): Promise<Boot> {
  const state = await getExamState(applicationId);
  if (state.status !== 'IN_PROGRESS') return { state, sessionId: '', receivedAt: Date.now() };
  const stored = readSessionId(state.attemptId);
  // A stored id is ours only if no other live tab is using it: "Duplicate tab" copies
  // sessionStorage, and two tabs on one session would overwrite each other unnoticed.
  if (stored && !(await tabPresenceFor(state.attemptId).probe())) {
    return { state, sessionId: stored, receivedAt: Date.now() };
  }
  // A new or duplicated tab (or a reopened browser): take over, which the server logs as
  // SESSION_TAKEOVER and which supersedes the other window.
  const resumed = await resumeExam(applicationId);
  return { state: resumed, sessionId: resumed.sessionId ?? '', receivedAt: Date.now() };
}

// localStorage can be missing or throw (private mode, blocked site data); the autosaver
// treats a failing store as "no mirror" and keeps the text in memory and on retry.
const safeLocal: MirrorStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* quota or blocked */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* blocked */
    }
  },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => undefined, () => undefined), sleep(ms)]);

export default function CandidateExam() {
  const { applicationId = '' } = useParams();
  const qc = useQueryClient();
  const boot = useQuery({
    queryKey: bootKey(applicationId),
    queryFn: () => bootExam(applicationId),
    gcTime: 0,
    staleTime: Infinity,
    retry: (n, err) => !(err instanceof ApiError) && n < 3,
  });

  // The exam screen is always light, whatever the rest of the app does.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark');
    root.style.colorScheme = 'light';
  }, []);

  const takeOver = useCallback(async () => {
    const s = await resumeExam(applicationId);
    qc.setQueryData<Boot>(bootKey(applicationId), { state: s, sessionId: s.sessionId ?? '', receivedAt: Date.now() });
  }, [qc, applicationId]);

  if (boot.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8 text-sm text-muted-foreground" role="status">
        Loading your exam…
      </div>
    );
  }
  if (boot.isError) {
    const code = boot.error instanceof ApiError ? boot.error.code : null;
    if (code === 'NOT_FOUND' || code === 'FORBIDDEN') return <Navigate to="/dashboard" replace />;
    if (code === 'ATTEMPT_LOCKED' || code === 'ALREADY_ATTEMPTED') return <Navigate to={examPaths.submitted(applicationId)} replace />;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center">
        <p className="text-sm text-foreground" role="alert">
          We couldn&apos;t load your exam. Your answers are safe; check your connection and try again.
        </p>
        <Button variant="outline" onClick={() => void boot.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (boot.data.state.status !== 'IN_PROGRESS') return <Navigate to={examPaths.submitted(applicationId)} replace />;
  return <ExamRunner key={boot.data.sessionId} applicationId={applicationId} boot={boot.data} onTakeOver={takeOver} />;
}

interface Local {
  text: string;
  markedForReview: boolean;
  visited: boolean;
}

function ExamRunner({ applicationId, boot, onTakeOver }: { applicationId: string; boot: Boot; onTakeOver: () => Promise<void> }) {
  const { state, sessionId } = boot;
  const navigate = useNavigate();
  const candidate = useCandidateAuth((s) => s.candidate);
  const examInfo = useCandidateExam(applicationId).data?.exam;
  const invalidateExams = useInvalidateExams();
  const questions = useMemo(() => [...state.questions].sort((a, b) => a.order - b.order), [state.questions]);
  const mirrorKey = useCallback((aqId: string) => `exam:${state.attemptId}:${aqId}`, [state.attemptId]);

  // Decide once, before the first render, which questions get their stored text back.
  const [plan] = useState(() =>
    questions.map((q) => {
      const mirror = readMirror(safeLocal, mirrorKey(q.attemptQuestionId));
      const server = { text: q.answer.text, clientSeq: q.answer.clientSeq, lastSavedAt: q.answer.lastSavedAt };
      return { q, mirror, restore: shouldRestoreMirror(mirror, server) };
    }),
  );
  const [answers, setAnswers] = useState<Record<string, Local>>(() =>
    Object.fromEntries(
      plan.map(({ q, mirror, restore }) => [
        q.attemptQuestionId,
        { text: restore && mirror ? mirror.text : q.answer.text, markedForReview: q.answer.markedForReview, visited: q.answer.visited },
      ]),
    ),
  );
  const [currentId, setCurrentId] = useState(() => questions[0]?.attemptQuestionId ?? '');
  const currentRef = useRef(currentId);
  currentRef.current = currentId;

  const clockRef = useRef<ServerClock>(createServerClock(state.serverNow, boot.receivedAt));
  const endsAtRef = useRef(state.endsAt);
  const [remaining, setRemaining] = useState(() => clockRef.current.remainingMs(state.endsAt));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [phase, setPhase] = useState<LifecyclePhase>('active');
  const phaseRef = useRef<LifecyclePhase>('active');
  const [timeUpNotice, setTimeUpNotice] = useState<string | null>(null);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const [takingOver, setTakingOver] = useState(false);
  const [toast, setToast] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const saverRef = useRef<Autosaver | null>(null);
  const eventsRef = useRef<ReturnType<typeof createEventQueue> | null>(null);
  const lifecycleRef = useRef<ExamLifecycle | null>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const invalidateRef = useRef(invalidateExams);
  invalidateRef.current = invalidateExams;

  // ---- autosaver + event queue + lifecycle (one set per session) ------------------------
  useEffect(() => {
    const saver = createAutosaver({
      save: (p) => saveAnswer(applicationId, sessionId, p),
      beacon: (p) => beaconAnswer(applicationId, sessionId, p),
      debounceMs: 2000,
      storage: safeLocal,
      key: mirrorKey,
      now: () => clockRef.current.now(),
      resolveStale: async (id) => {
        const fresh = await getExamState(applicationId);
        clockRef.current = createServerClock(fresh.serverNow);
        if (fresh.status !== 'IN_PROGRESS') throw Object.assign(new Error('locked'), { code: 'ATTEMPT_LOCKED' });
        const a = fresh.questions.find((q) => q.attemptQuestionId === id)?.answer;
        if (!a) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND', status: 404 });
        return { text: a.text, clientSeq: a.clientSeq };
      },
      onAccepted: (r) => {
        clockRef.current = createServerClock(r.serverNow);
      },
    });
    let restored = false;
    for (const { q, mirror, restore } of plan) {
      const id = q.attemptQuestionId;
      const clientSeq = Math.max(q.answer.clientSeq, mirror?.seq ?? 0);
      if (restore && mirror) {
        saver.seed(id, { clientSeq, text: q.answer.text }, { typed: mirror.typed, restored: mirror.restored, since: mirror.since });
        saver.update(id, mirror.text, 0);
        restored = true;
      } else {
        saver.seed(id, { clientSeq, text: q.answer.text });
        if (mirror) safeLocal.removeItem(mirrorKey(id));
      }
    }
    if (restored) void saver.flush();
    const unsubscribe = saver.status$.subscribe(setStatus);
    saverRef.current = saver;

    const events = createEventQueue({
      send: (batch) => postEvents(applicationId, sessionId, batch),
      beacon: (batch) => beaconEvents(applicationId, sessionId, batch),
      onSuperseded: () => lifecycleRef.current?.supersede(),
      intervalMs: 5000,
    });
    events.start();
    eventsRef.current = events;

    // Owns the deadline, supersede (server or broadcast) and who may clear the shared copies.
    const lifecycle = createExamLifecycle({
      saver,
      presence: tabPresenceFor(state.attemptId),
      events,
      storage: safeLocal,
      mirrorKeys: questions.map((q) => mirrorKey(q.attemptQuestionId)),
      forgetSession: () => forgetSession(state.attemptId),
      remainingMs: () => clockRef.current.remainingMs(endsAtRef.current),
      onChange: (s) => {
        phaseRef.current = s.phase;
        setPhase(s.phase);
        setTimeUpNotice(s.timeUpNotice);
        if (s.phase !== 'active') setSubmitOpen(false);
      },
      onTimeUpDone: () => {
        void invalidateRef.current();
        navigateRef.current(examPaths.submitted(applicationId), { replace: true });
      },
    });
    lifecycleRef.current = lifecycle;

    return () => {
      lifecycle.dispose();
      unsubscribe();
      saver.dispose();
      events.stop();
      saverRef.current = null;
      eventsRef.current = null;
      lifecycleRef.current = null;
    };
    // Built once per mounted session; the runner is keyed by sessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const push = useCallback((type: ExamEventType, metadata?: Record<string, unknown>) => {
    eventsRef.current?.push({ type, questionId: currentRef.current || undefined, at: new Date(clockRef.current.now()).toISOString(), metadata });
  }, []);

  // ---- leaving the exam ----------------------------------------------------------------
  const onLocked = useCallback(() => {
    const lifecycle = lifecycleRef.current;
    if (!lifecycle || phaseRef.current !== 'active') return;
    // Locked at the deadline: the normal time-up flow. Locked while time remains means it
    // was submitted elsewhere or reset by an admin: leave without touching local copies.
    if (clockRef.current.remainingMs(endsAtRef.current) <= 15_000) {
      void lifecycle.timeUp();
      return;
    }
    lifecycle.abandon();
    void invalidateExams();
    navigate(examPaths.submitted(applicationId), { replace: true });
  }, [navigate, applicationId, invalidateExams]);

  useEffect(() => {
    if (status === 'locked') onLocked();
  }, [status, onLocked]);

  // ---- timer display (the deadline itself is the lifecycle's) ---------------------------
  useEffect(() => {
    const t = setInterval(() => setRemaining(clockRef.current.remainingMs(endsAtRef.current)), 500);
    return () => clearInterval(t);
  }, []);

  // Re-sync the clock (and notice a server-side lock) every 60 s.
  const sync = useQuery({
    queryKey: ['candidate', 'exam', 'sync', applicationId, sessionId],
    queryFn: () => getExamState(applicationId),
    initialData: state,
    initialDataUpdatedAt: boot.receivedAt,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    enabled: phase === 'active',
  });
  useEffect(() => {
    if (sync.dataUpdatedAt === boot.receivedAt) return;
    clockRef.current = createServerClock(sync.data.serverNow, sync.dataUpdatedAt);
    endsAtRef.current = sync.data.endsAt;
    setRemaining(clockRef.current.remainingMs(sync.data.endsAt));
    if (sync.data.status !== 'IN_PROGRESS') onLocked();
  }, [sync.data, sync.dataUpdatedAt, boot.receivedAt, onLocked]);

  // ---- browser events: paste guard, activity, unload ------------------------------------
  useEffect(() => {
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    const detachGuard = attachPasteGuard(document, (kind, inputType) => {
      push(BLOCKED_EVENT[kind], inputType ? { inputType } : undefined);
      setToast(true);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => setToast(false), 5000);
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        push('TAB_HIDDEN');
        void saverRef.current?.flush();
        void eventsRef.current?.flush();
      } else push('TAB_VISIBLE');
    };
    const onBlur = () => push('WINDOW_BLUR');
    const onFocus = () => push('WINDOW_FOCUS');
    const onOnline = () => {
      push('NETWORK_ONLINE');
      void saverRef.current?.flush();
      void eventsRef.current?.flush();
    };
    const onOffline = () => push('NETWORK_OFFLINE');
    const onPageHide = () => {
      push('PAGE_UNLOAD');
      saverRef.current?.flushBeacon();
      eventsRef.current?.flushBeacon();
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = saverRef.current?.status$.get();
      if (phaseRef.current === 'active' && s && s !== 'saved' && s !== 'superseded' && s !== 'locked') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      clearTimeout(toastTimer);
      detachGuard();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [push]);

  // ---- navigation, answers, flags ------------------------------------------------------
  const answersRef = useRef(answers);
  answersRef.current = answers;
  useEffect(() => {
    if (!currentId) return;
    push('QUESTION_VIEWED');
    const a = answersRef.current[currentId];
    if (!a || a.visited) return;
    saverRef.current?.setFlags(currentId, { visited: true });
    setAnswers((prev) => ({ ...prev, [currentId]: { ...prev[currentId]!, visited: true } }));
  }, [currentId, push]);

  const goTo = (id: string) => {
    if (id === currentId) return;
    void saverRef.current?.flush(currentId);
    setCurrentId(id);
    window.scrollTo({ top: 0 });
  };

  const onAnswer = (text: string, typedDelta: number, restoredDelta: number) => {
    const id = currentId;
    setAnswers((prev) => ({ ...prev, [id]: { ...prev[id]!, text } }));
    saverRef.current?.update(id, text, typedDelta, restoredDelta);
  };

  const toggleReview = () => {
    const id = currentId;
    const next = !answers[id]?.markedForReview;
    setAnswers((prev) => ({ ...prev, [id]: { ...prev[id]!, markedForReview: next } }));
    saverRef.current?.setFlags(id, { markedForReview: next });
  };

  const palette: PaletteItem[] = useMemo(
    () =>
      questions.map((q, i) => {
        const a = answers[q.attemptQuestionId];
        const state = a?.markedForReview ? 'marked' : a && countWords(a.text) > 0 ? 'answered' : a?.visited ? 'unanswered' : 'not-visited';
        return { id: q.attemptQuestionId, number: i + 1, state };
      }),
    [questions, answers],
  );
  const unanswered = palette.filter((p) => answers[p.id] && countWords(answers[p.id]!.text) === 0).length;
  const marked = palette.filter((p) => answers[p.id]?.markedForReview).length;

  // ---- submit ---------------------------------------------------------------------------
  const onSubmit = async () => {
    const saver = saverRef.current;
    if (!saver) return;
    setSubmitting(true);
    setSubmitError(null);
    await within(saver.flush(), 15_000);
    const s = saver.status$.get();
    if (s === 'superseded' || s === 'locked') {
      setSubmitting(false);
      setSubmitOpen(false);
      return;
    }
    if (saver.hasUnsaved()) {
      setSubmitting(false);
      setSubmitError('Some of your answers are not saved yet. Check your connection, then try again.');
      return;
    }
    if (eventsRef.current) await within(eventsRef.current.flush(), 3000);
    try {
      await submitExam(applicationId, sessionId);
      lifecycleRef.current?.finishSubmitted(); // clears local copies only if this tab owns the session
      void invalidateExams();
      navigate(examPaths.submitted(applicationId), { replace: true });
    } catch (e) {
      setSubmitting(false);
      if (e instanceof ApiError && e.code === 'SESSION_SUPERSEDED') {
        setSubmitOpen(false);
        lifecycleRef.current?.supersede();
      } else if (e instanceof ApiError && e.code === 'ATTEMPT_LOCKED') onLocked();
      else setSubmitError(e instanceof ApiError ? e.message : 'Could not submit. Check your connection, then try again.');
    }
  };

  const onContinueHere = async () => {
    setTakingOver(true);
    setTakeoverError(null);
    try {
      await onTakeOver(); // remounts this runner with the new session
    } catch (e) {
      setTakingOver(false);
      if (e instanceof ApiError && e.code === 'ATTEMPT_LOCKED') onLocked();
      else setTakeoverError(e instanceof ApiError ? e.message : 'Could not continue here. Check your connection, then try again.');
    }
  };

  // ---- render ---------------------------------------------------------------------------
  const index = questions.findIndex((q) => q.attemptQuestionId === currentId);
  const question = questions[index];
  const current = answers[currentId];
  const locked = phase !== 'active';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ExamHeader
        name={candidate?.fullName ?? ''}
        code={examInfo?.candidateCode ?? ''}
        role={examInfo?.jobRole.name ?? ''}
        remainingMs={remaining}
        status={status}
      />

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section aria-labelledby="question-heading" className="min-w-0 space-y-4">
          {question && current && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 id="question-heading" className="text-base font-semibold">
                  Question {index + 1} of {questions.length}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">({question.maxMarks} marks)</span>
                </h1>
                <Button type="button" variant="outline" size="sm" onClick={toggleReview} disabled={locked} aria-pressed={current.markedForReview}>
                  <Flag className={cn('mr-1.5 h-4 w-4', current.markedForReview && 'fill-violet-500 text-violet-600')} aria-hidden="true" />
                  {current.markedForReview ? 'Marked for review' : 'Mark for review'}
                </Button>
              </div>
              <p className="select-none whitespace-pre-line rounded-lg border bg-card p-4 text-[15px] leading-relaxed">{question.text}</p>
              <AnswerBox
                key={question.attemptQuestionId}
                id={`answer-${question.attemptQuestionId}`}
                label={`Answer to question ${index + 1}`}
                value={current.text}
                readOnly={locked}
                onChange={onAnswer}
              />
              <div className="flex items-center justify-between gap-2">
                <Button type="button" variant="outline" disabled={index <= 0} onClick={() => goTo(questions[index - 1]!.attemptQuestionId)}>
                  <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Previous
                </Button>
                {index < questions.length - 1 ? (
                  <Button type="button" variant="outline" onClick={() => goTo(questions[index + 1]!.attemptQuestionId)}>
                    Next <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
                  </Button>
                ) : (
                  <Button type="button" onClick={() => setSubmitOpen(true)} disabled={locked}>
                    Submit exam
                  </Button>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="order-first space-y-4 lg:order-last">
          <div className="rounded-lg border bg-card p-4">
            <QuestionPalette items={palette} currentId={currentId} onSelect={goTo} />
          </div>
          <Button type="button" className="w-full" onClick={() => setSubmitOpen(true)} disabled={locked}>
            Submit exam
          </Button>
        </aside>
      </main>

      <SubmitDialog
        open={submitOpen}
        onOpenChange={(o) => {
          setSubmitOpen(o);
          if (!o) setSubmitError(null);
        }}
        total={questions.length}
        unanswered={unanswered}
        marked={marked}
        pending={submitting}
        error={submitError}
        onConfirm={() => void onSubmit()}
      />

      {toast && (
        <div role="alert" className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-md rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg">
          {BLOCKED_TOAST}
        </div>
      )}

      {phase === 'superseded' && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 p-4" role="alertdialog" aria-modal="true" aria-labelledby="superseded-title">
          <div className="w-full max-w-md space-y-4 rounded-2xl border bg-card p-6 text-center shadow-lg">
            <h2 id="superseded-title" className="text-lg font-semibold">
              This exam is open in another window
            </h2>
            <p className="text-sm text-muted-foreground">Only one window can be used at a time. The timer keeps running.</p>
            <div aria-live="polite">{takeoverError && <p className="text-sm text-destructive">{takeoverError}</p>}</div>
            <Button type="button" onClick={() => void onContinueHere()} loading={takingOver} autoFocus>
              Continue here
            </Button>
          </div>
        </div>
      )}

      {phase === 'timeup' && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 p-4" role="alertdialog" aria-modal="true" aria-labelledby="timeup-title">
          <div className="w-full max-w-md space-y-3 rounded-2xl border bg-card p-6 text-center shadow-lg">
            <h2 id="timeup-title" className="text-lg font-semibold">
              {TIME_UP}
            </h2>
            {timeUpNotice && <p className="text-sm text-amber-800">{timeUpNotice}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
