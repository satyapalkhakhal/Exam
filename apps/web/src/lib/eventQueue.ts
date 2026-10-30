// src/lib/eventQueue.ts
// Why: activity events (tab switches, blocked pastes, going offline) are evidence, so they
// are batched rather than sent one by one, kept in order across failed sends, and drained
// by a keepalive request on pagehide. The API takes at most 50 per request.

export type ExamEventType =
  | 'QUESTION_VIEWED'
  | 'PASTE_ATTEMPT'
  | 'COPY_ATTEMPT'
  | 'CUT_ATTEMPT'
  | 'DROP_ATTEMPT'
  | 'CONTEXT_MENU'
  | 'TAB_HIDDEN'
  | 'TAB_VISIBLE'
  | 'WINDOW_BLUR'
  | 'WINDOW_FOCUS'
  | 'PAGE_UNLOAD'
  | 'NETWORK_OFFLINE'
  | 'NETWORK_ONLINE';

export interface QueuedEvent {
  type: ExamEventType;
  questionId?: string;
  at: string;
  metadata?: Record<string, unknown>;
}

export interface EventQueueOptions {
  send(batch: QueuedEvent[]): Promise<void>;
  beacon(batch: QueuedEvent[]): void;
  onSuperseded?(): void;
  intervalMs: number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
}

const MAX_BATCH = 50;
/** A long outage must not grow memory without bound; the oldest events go first. */
const MAX_QUEUED = 1000;

export function createEventQueue(opts: EventQueueOptions) {
  const timers = opts.timers ?? {
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (h: unknown) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  };
  let queue: QueuedEvent[] = [];
  let handle: unknown = null;
  let sending = false;
  let stopped = false;

  async function flush(): Promise<void> {
    if (sending || stopped) return;
    sending = true;
    try {
      while (queue.length > 0 && !stopped) {
        const batch = queue.slice(0, MAX_BATCH);
        try {
          await opts.send(batch);
          queue = queue.slice(batch.length);
        } catch (err) {
          if ((err as { code?: unknown }).code === 'SESSION_SUPERSEDED') {
            stop();
            opts.onSuperseded?.();
          }
          return;
        }
      }
    } finally {
      sending = false;
    }
  }

  function stop() {
    stopped = true;
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  }

  return {
    start() {
      if (handle === null && !stopped) handle = timers.setInterval(() => void flush(), opts.intervalMs);
    },
    push(e: QueuedEvent) {
      if (stopped) return;
      queue.push(e);
      if (queue.length > MAX_QUEUED) queue = queue.slice(queue.length - MAX_QUEUED);
    },
    flush,
    flushBeacon() {
      if (stopped) return;
      while (queue.length > 0) opts.beacon(queue.splice(0, MAX_BATCH));
    },
    stop,
  };
}
