// src/lib/tabPresence.ts
// Why: "Duplicate tab" copies sessionStorage, so a duplicate would carry the same attempt
// session id as the original and the server could not tell them apart. Each page load gets
// an in-memory tab id (never inherited) and asks, on a BroadcastChannel per attempt, whether
// another tab is already running this exam. If one answers, this tab takes over via
// /exam/resume and announces it, and the other tab shows the superseded notice at once.
// Without BroadcastChannel the probe is false and the server's session check still applies.

export interface ChannelLike {
  postMessage(data: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

type Msg = { type: 'hello'; from: string } | { type: 'here'; from: string; to: string } | { type: 'took-over'; from: string };

export interface TabPresence {
  readonly tabId: string;
  /** True if another tab answers within `timeoutMs` that it is running this exam. */
  probe(timeoutMs?: number): Promise<boolean>;
  /** Whether this tab claims the exam (answers probes). */
  setAnswering(on: boolean): void;
  announceTakeover(): void;
  onTakenOver(fn: () => void): () => void;
}

export function createTabPresence({ channel, tabId }: { channel: ChannelLike | null; tabId: string }): TabPresence {
  let answering = false;
  const heard = new Set<() => void>();
  const takenOver = new Set<() => void>();

  if (channel) {
    channel.onmessage = (e) => {
      const m = e.data as Msg;
      if (!m || typeof m !== 'object' || m.from === tabId) return;
      if (m.type === 'hello' && answering) channel.postMessage({ type: 'here', from: tabId, to: m.from } satisfies Msg);
      else if (m.type === 'here' && m.to === tabId) for (const fn of heard) fn();
      else if (m.type === 'took-over') {
        answering = false;
        for (const fn of takenOver) fn();
      }
    };
  }

  return {
    tabId,
    probe(timeoutMs = 400) {
      if (!channel) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const done = (v: boolean) => {
          heard.delete(onHere);
          clearTimeout(timer);
          resolve(v);
        };
        const onHere = () => done(true);
        heard.add(onHere);
        const timer = setTimeout(() => done(false), timeoutMs);
        channel.postMessage({ type: 'hello', from: tabId } satisfies Msg);
      });
    },
    setAnswering(on) {
      answering = on;
    },
    announceTakeover() {
      channel?.postMessage({ type: 'took-over', from: tabId } satisfies Msg);
    },
    onTakenOver(fn) {
      takenOver.add(fn);
      return () => takenOver.delete(fn);
    },
  };
}

const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const byAttempt = new Map<string, TabPresence>();

/** This tab's presence for an attempt (one per page load, so a duplicated tab gets its own). */
export function tabPresenceFor(attemptId: string): TabPresence {
  let p = byAttempt.get(attemptId);
  if (!p) {
    let channel: ChannelLike | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(`exam:${attemptId}`) as unknown as ChannelLike;
    } catch {
      channel = null;
    }
    p = createTabPresence({ channel, tabId: TAB_ID });
    byAttempt.set(attemptId, p);
  }
  return p;
}
