// src/lib/autosave.ts
// Why: a candidate must never lose typed text (design 7.5). Every keystroke is mirrored to
// storage at once; saves are debounced, serialised per question (one in flight, so an older
// text can never be acknowledged after a newer one), retried with backoff for as long as it
// takes, and stopped only by the two terminal answers: another window took over, or the
// attempt is locked. typedChars/intervalMs are the evidence the server's bulk-insert check uses,
// so they accumulate from the last *accepted* save and carry over failures.

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'error' | 'superseded' | 'locked';

export interface AnswerFlags {
  markedForReview?: boolean;
  visited?: boolean;
}

export interface SavePayload extends AnswerFlags {
  attemptQuestionId: string;
  clientSeq: number;
  text: string;
  typedChars: number;
  /** Undo/Redo re-insertions, excused from the growth check but not counted as typing. */
  restoredChars: number;
  intervalMs: number;
}

export type SaveResult =
  | { accepted: true; serverNow: string; lastSavedAt: string }
  | { accepted: false; reason: 'STALE' };

/** What is kept in storage for a question with unsaved text. Times are from `now()`. */
export interface MirrorRecord {
  text: string;
  /** When the text was last changed. */
  at: number;
  /** The highest clientSeq this text (or an earlier one) was sent with. */
  seq: number;
  /** Typed characters not yet accepted by the server. */
  typed: number;
  /** Undo/Redo characters not yet accepted by the server (absent in mirrors written before it existed). */
  restored?: number;
  /** When the last accepted save was sent (start of the current intervalMs). */
  since: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type MirrorStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AutosaverOptions {
  save(payload: SavePayload): Promise<SaveResult>;
  /** Fire-and-forget send for pagehide; returns false if the browser refused it. */
  beacon?(payload: SavePayload): boolean;
  debounceMs: number;
  storage: MirrorStorage;
  key(attemptQuestionId: string): string;
  now?: () => number;
  timers?: Timers;
  /** On STALE: what the server holds now for this question (GET /exam). */
  resolveStale(attemptQuestionId: string): Promise<{ text: string; clientSeq: number }>;
  onAccepted?(result: Extract<SaveResult, { accepted: true }>, attemptQuestionId: string): void;
}

export interface Autosaver {
  /** Start a question from the server copy; restore (from a mirror) keeps its typed/since evidence. */
  seed(id: string, init: { clientSeq: number; text: string } & AnswerFlags, restore?: Pick<MirrorRecord, 'typed' | 'since' | 'restored'>): void;
  update(id: string, text: string, typedDelta: number, restoredDelta?: number): void;
  setFlags(id: string, flags: AnswerFlags): void;
  /** Send now; resolves when the question(s) have nothing in flight (saved or failed). */
  flush(id?: string): Promise<void>;
  flushBeacon(): void;
  hasUnsaved(): boolean;
  /** Another tab took over (broadcast): stop exactly as a server SESSION_SUPERSEDED would. */
  supersede(): void;
  status$: { subscribe(fn: (s: SaveStatus) => void): () => void; get(): SaveStatus };
  dispose(): void;
}

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000] as const;

interface QState {
  seq: number;
  ackedText: string;
  text: string;
  flags: AnswerFlags;
  typed: number;
  restored: number;
  since: number;
  inFlight: boolean;
  again: boolean;
  debounce: unknown;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

function errorKind(err: unknown): 'superseded' | 'locked' | 'offline' | 'error' {
  if (typeof err === 'object' && err !== null) {
    const { code, status } = err as { code?: unknown; status?: unknown };
    if (code === 'SESSION_SUPERSEDED') return 'superseded';
    if (code === 'ATTEMPT_LOCKED') return 'locked';
    // A gateway error means the API is unreachable: to the candidate that is "offline".
    if (typeof status === 'number') return status === 0 || status >= 502 ? 'offline' : 'error';
  }
  return 'offline';
}

export function createAutosaver(opts: AutosaverOptions): Autosaver {
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realTimers;
  const qs = new Map<string, QState>();
  const listeners = new Set<(s: SaveStatus) => void>();
  const waiters: { ids: string[]; resolve: () => void }[] = [];
  let stopped: 'superseded' | 'locked' | null = null;
  let disposed = false;
  let failures = 0;
  let failMode: 'offline' | 'error' = 'offline';
  let retry: unknown = null;
  let status: SaveStatus = 'saved';

  const hasFlags = (q: QState) => q.flags.markedForReview !== undefined || q.flags.visited !== undefined;
  const dirty = (q: QState) => q.text !== q.ackedText || hasFlags(q);

  function get(id: string): QState {
    let q = qs.get(id);
    if (!q) {
      q = { seq: 0, ackedText: '', text: '', flags: {}, typed: 0, restored: 0, since: now(), inFlight: false, again: false, debounce: null };
      qs.set(id, q);
    }
    return q;
  }

  function computeStatus(): SaveStatus {
    if (stopped) return stopped;
    if (failures > 0) return failMode;
    for (const q of qs.values()) if (q.inFlight || dirty(q)) return 'saving';
    return 'saved';
  }

  function emit() {
    const next = computeStatus();
    if (next === status) return;
    status = next;
    for (const l of listeners) l(next);
  }

  function writeMirror(id: string, q: QState) {
    const rec: MirrorRecord = { text: q.text, at: now(), seq: q.seq, typed: q.typed, restored: q.restored, since: q.since };
    try {
      opts.storage.setItem(opts.key(id), JSON.stringify(rec));
    } catch {
      // Storage full or blocked: the in-memory copy and the retries still hold the text.
    }
  }

  function clearMirror(id: string) {
    try {
      opts.storage.removeItem(opts.key(id));
    } catch {
      /* see writeMirror */
    }
  }

  function settleWaiters() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      const busy = !stopped && !disposed && w.ids.some((id) => {
        const q = qs.get(id);
        return q !== undefined && (q.inFlight || q.again);
      });
      if (!busy) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  function clearDebounce(q: QState) {
    if (q.debounce !== null) {
      timers.clearTimeout(q.debounce);
      q.debounce = null;
    }
  }

  function scheduleRetry() {
    if (retry !== null || stopped || disposed) return;
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 15_000;
    retry = timers.setTimeout(() => {
      retry = null;
      for (const [id, q] of qs) if (dirty(q)) send(id);
    }, delay);
  }

  function buildPayload(id: string, q: QState): SavePayload {
    q.seq += 1;
    return {
      attemptQuestionId: id,
      clientSeq: q.seq,
      text: q.text,
      typedChars: q.typed,
      restoredChars: q.restored,
      intervalMs: Math.max(0, now() - q.since),
      ...q.flags,
    };
  }

  function acknowledge(id: string, q: QState, payload: SavePayload, sentAt: number, sentFlags: AnswerFlags) {
    q.ackedText = payload.text;
    q.typed = Math.max(0, q.typed - payload.typedChars);
    q.restored = Math.max(0, q.restored - payload.restoredChars);
    q.since = sentAt;
    if (q.flags.markedForReview === sentFlags.markedForReview) delete q.flags.markedForReview;
    if (q.flags.visited === sentFlags.visited) delete q.flags.visited;
  }

  function send(id: string) {
    if (stopped || disposed) return;
    const q = get(id);
    clearDebounce(q);
    if (q.inFlight) {
      q.again = true;
      return;
    }
    if (!dirty(q)) {
      settleWaiters();
      return;
    }
    void run(id, q);
  }

  async function run(id: string, q: QState) {
    const sentAt = now();
    const payload = buildPayload(id, q);
    const sentFlags = { ...q.flags };
    writeMirror(id, q);
    q.inFlight = true;
    emit();

    try {
      const result = await opts.save(payload);
      if (disposed) return;
      if (result.accepted) {
        acknowledge(id, q, payload, sentAt, sentFlags);
        opts.onAccepted?.(result, id);
      } else {
        // STALE: the server holds a save with an equal or higher clientSeq (another copy of
        // this tab, or a pagehide beacon). It only counts as saved if that save *is* our text;
        // otherwise jump above the server's seq and send ours again. Never drop the mirror here.
        const server = await opts.resolveStale(id);
        if (disposed) return;
        q.seq = Math.max(q.seq, server.clientSeq);
        if (server.text === payload.text) acknowledge(id, q, payload, sentAt, sentFlags);
        else {
          q.ackedText = server.text;
          q.again = true;
        }
      }
      failures = 0;
      if (retry !== null) {
        timers.clearTimeout(retry);
        retry = null;
      }
      if (dirty(q)) writeMirror(id, q);
      else clearMirror(id);
    } catch (err) {
      if (disposed) return;
      q.again = false;
      const kind = errorKind(err);
      if (kind === 'superseded' || kind === 'locked') {
        stopped = kind;
        stopTimers();
      } else {
        failures += 1;
        failMode = kind;
        scheduleRetry();
      }
    } finally {
      q.inFlight = false;
    }

    if (!stopped && failures === 0) {
      // Anything typed while this save was in flight goes next: either it asked to (again),
      // or its debounce already fired and found the line busy. A pending debounce sends it later.
      if (q.again || (dirty(q) && q.debounce === null)) {
        q.again = false;
        send(id);
      }
      // Other questions that failed alongside this one go now that the line is back.
      for (const [otherId, other] of qs) if (other !== q && dirty(other) && !other.inFlight && other.debounce === null) send(otherId);
    }
    emit();
    settleWaiters();
  }

  function stopTimers() {
    if (retry !== null) timers.clearTimeout(retry);
    retry = null;
    for (const q of qs.values()) clearDebounce(q);
  }

  return {
    seed(id, init, restore) {
      const q = get(id);
      q.seq = Math.max(q.seq, init.clientSeq);
      q.ackedText = init.text;
      q.text = init.text;
      if (restore) {
        q.typed = restore.typed;
        q.restored = restore.restored ?? 0;
        q.since = restore.since;
      }
      emit();
    },

    update(id, text, typedDelta, restoredDelta = 0) {
      if (stopped || disposed) return;
      const q = get(id);
      q.text = text;
      q.typed += Math.max(0, typedDelta);
      q.restored += Math.max(0, restoredDelta);
      writeMirror(id, q);
      clearDebounce(q);
      q.debounce = timers.setTimeout(() => {
        q.debounce = null;
        // While retrying, the backoff timer owns sending; a save in flight marks itself to go again.
        if (failures === 0 || q.inFlight) send(id);
      }, opts.debounceMs);
      emit();
    },

    setFlags(id, flags) {
      if (stopped || disposed) return;
      const q = get(id);
      Object.assign(q.flags, flags);
      clearDebounce(q);
      q.debounce = timers.setTimeout(() => {
        q.debounce = null;
        if (failures === 0 || q.inFlight) send(id);
      }, opts.debounceMs);
      emit();
    },

    flush(id) {
      const ids = id === undefined ? [...qs.keys()] : [id];
      const done = new Promise<void>((resolve) => waiters.push({ ids, resolve }));
      for (const i of ids) {
        const q = qs.get(i);
        if (q && dirty(q)) send(i);
      }
      settleWaiters();
      return done;
    },

    flushBeacon() {
      if (stopped || disposed || !opts.beacon) return;
      for (const [id, q] of qs) {
        if (!dirty(q)) continue;
        const payload = buildPayload(id, q);
        writeMirror(id, q);
        opts.beacon(payload);
      }
    },

    hasUnsaved: () => [...qs.values()].some((q) => q.inFlight || dirty(q)),

    supersede() {
      if (disposed || stopped) return;
      stopped = 'superseded';
      stopTimers();
      emit();
      settleWaiters();
    },

    status$: {
      subscribe(fn) {
        listeners.add(fn);
        fn(status);
        return () => listeners.delete(fn);
      },
      get: () => status,
    },

    dispose() {
      disposed = true;
      stopTimers();
      listeners.clear();
      for (const w of waiters.splice(0)) w.resolve();
    },
  };
}

/**
 * On load: should this question's storage mirror replace the server copy? Only when the
 * server never accepted it (higher seq), or it holds typing made after the server's last
 * accepted save (same seq, but newer or longer). A lower seq means another window saved
 * something newer since, so the mirror is stale.
 */
export function shouldRestoreMirror(
  mirror: MirrorRecord | null,
  server: { text: string; clientSeq: number; lastSavedAt: string | null },
): boolean {
  if (!mirror || mirror.text === server.text) return false;
  if (mirror.seq < server.clientSeq) return false;
  if (mirror.seq > server.clientSeq) return true;
  if (server.lastSavedAt === null) return true;
  return mirror.at >= Date.parse(server.lastSavedAt) || mirror.text.length > server.text.length;
}

export function readMirror(storage: MirrorStorage, key: string): MirrorRecord | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<MirrorRecord>;
    if (typeof v.text !== 'string' || typeof v.seq !== 'number') return null;
    return { text: v.text, seq: v.seq, at: Number(v.at) || 0, typed: Number(v.typed) || 0, restored: Number(v.restored) || 0, since: Number(v.since) || 0 };
  } catch {
    return null;
  }
}
