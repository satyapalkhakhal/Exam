// src/lib/examLifecycle.ts
// Why: how an exam tab stops. Answer copies in localStorage (exam:{attemptId}:{aqId}) are
// shared by every tab of the origin, so only the tab that owns the session may ever clear
// them: a superseded tab (told by the server or by another tab's broadcast) stops saving,
// never runs the time-up flow, and only forgets its own session id. The owner clears the
// copies after a submit, or at time-up only if everything reached the server.

import type { Autosaver, MirrorStorage } from './autosave';
import { timeUpOutcome } from './examEnd';
import type { TabPresence } from './tabPresence';

export type LifecyclePhase = 'active' | 'superseded' | 'ending' | 'timeup';

export interface LifecycleState {
  phase: LifecyclePhase;
  timeUpNotice: string | null;
}

export interface ExamLifecycleOptions {
  saver: Autosaver;
  presence: Pick<TabPresence, 'setAnswering' | 'onTakenOver'>;
  events: { flush(): Promise<void>; stop(): void };
  storage: MirrorStorage;
  mirrorKeys: string[];
  forgetSession(): void;
  /** Server-synced time left; checked by the lifecycle's own deadline timer. */
  remainingMs(): number;
  onChange(s: LifecycleState): void;
  /** Time-up copy has been shown long enough; leave the exam screen. */
  onTimeUpDone(): void;
  sleep?: (ms: number) => Promise<void>;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  tickMs?: number;
}

export function createExamLifecycle(opts: ExamLifecycleOptions) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timers = opts.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  };
  const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => undefined, () => undefined), sleep(ms)]);

  let state: LifecycleState = { phase: 'active', timeUpNotice: null };
  let disposed = false;
  const set = (next: Partial<LifecycleState>) => {
    state = { ...state, ...next };
    if (!disposed) opts.onChange(state);
  };

  // Read through a function: the phase can change while timeUp() is awaiting a flush.
  const phase = (): LifecyclePhase => state.phase;
  const owns = () => state.phase !== 'superseded' && opts.saver.status$.get() !== 'superseded';

  function clearLocalCopies() {
    if (!owns()) return; // never touch copies another tab relies on
    for (const k of opts.mirrorKeys) opts.storage.removeItem(k);
  }

  function supersede() {
    if (state.phase === 'superseded') return;
    // Phase first: saver.supersede() emits 'superseded', which re-enters here.
    set({ phase: 'superseded' });
    opts.saver.supersede();
    opts.events.stop();
    opts.presence.setAnswering(false);
    opts.forgetSession(); // its own session id only; the shared answer copies stay
    timers.clearInterval(tick);
  }

  async function timeUp() {
    if (state.phase !== 'active') return;
    set({ phase: 'ending' });
    await within(opts.saver.flush(), 8000);
    await within(opts.events.flush(), 3000);
    // Superseded while flushing: the other tab owns the copies and the deadline now.
    if (phase() !== 'ending' || disposed) return;
    const outcome = timeUpOutcome({ status: opts.saver.status$.get(), hasUnsaved: opts.saver.hasUnsaved() });
    if (outcome.clearLocal) clearLocalCopies();
    opts.saver.dispose();
    opts.events.stop();
    opts.forgetSession();
    timers.clearInterval(tick);
    set({ phase: 'timeup', timeUpNotice: outcome.notice });
    await sleep(outcome.notice ? 8000 : 4000);
    if (!disposed) opts.onTimeUpDone();
  }

  const offStatus = opts.saver.status$.subscribe((s) => {
    if (s === 'superseded') supersede();
  });
  const offTaken = opts.presence.onTakenOver(supersede);
  opts.presence.setAnswering(true);
  const tick = timers.setInterval(() => {
    if (opts.remainingMs() <= 0) void timeUp();
  }, opts.tickMs ?? 500);

  return {
    get state() {
      return state;
    },
    supersede,
    timeUp,
    /** Manual submit accepted by the server. */
    finishSubmitted() {
      clearLocalCopies();
      opts.forgetSession();
      if (state.phase !== 'superseded') set({ phase: 'ending' });
      opts.saver.dispose();
      opts.events.stop();
      timers.clearInterval(tick);
    },
    /** Leaving without clearing anything (attempt locked elsewhere). */
    abandon() {
      if (state.phase === 'active') set({ phase: 'ending' });
      opts.saver.dispose();
      opts.events.stop();
      timers.clearInterval(tick);
    },
    dispose() {
      disposed = true;
      offStatus();
      offTaken();
      opts.presence.setAnswering(false);
      timers.clearInterval(tick);
    },
  };
}

export type ExamLifecycle = ReturnType<typeof createExamLifecycle>;
