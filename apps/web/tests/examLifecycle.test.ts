import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosaver, type SavePayload, type SaveResult } from '../src/lib/autosave.js';
import { createExamLifecycle, type LifecycleState } from '../src/lib/examLifecycle.js';
import { createTabPresence, type ChannelLike } from '../src/lib/tabPresence.js';

// ---- real autosaver + real tab presence over an in-memory channel, fake clock/timers ----

function bus() {
  const members = new Set<ChannelLike>();
  return () => {
    const ch: ChannelLike = {
      onmessage: null,
      postMessage(data: unknown) {
        for (const m of members) if (m !== ch) queueMicrotask(() => m.onmessage?.({ data: structuredClone(data) }));
      },
      close() {
        members.delete(ch);
      },
    };
    members.add(ch);
    return ch;
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

/** One shared localStorage (as across tabs of one origin). */
function sharedStorage() {
  const m = new Map<string, string>();
  return { map: m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

const KEY = (id: string) => `exam:att1:${id}`;
const ACCEPTED: SaveResult = { accepted: true, serverNow: '2026-11-01T10:00:00.000Z', lastSavedAt: '2026-11-01T10:00:00.000Z' };

function tab(opts: { storage: ReturnType<typeof sharedStorage>; open: () => ChannelLike; id: string; online: boolean }) {
  const saves: SavePayload[] = [];
  let online = opts.online;
  const intervals = new Map<number, () => void>();
  let n = 0;
  let remaining = 60_000;
  const saver = createAutosaver({
    save: async (p) => {
      saves.push(p);
      if (!online) throw new TypeError('Failed to fetch');
      return ACCEPTED;
    },
    resolveStale: async () => ({ text: '', clientSeq: 0 }),
    debounceMs: 2000,
    storage: opts.storage,
    key: KEY,
    // Inert timers: debounce/backoff never fire on their own, the lifecycle's flush sends.
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  const presence = createTabPresence({ channel: opts.open(), tabId: opts.id });
  const states: LifecycleState[] = [];
  let forgotten = 0;
  let done = 0;
  const lifecycle = createExamLifecycle({
    saver,
    presence,
    events: { flush: async () => {}, stop: () => {} },
    storage: opts.storage,
    mirrorKeys: [KEY('q1')],
    forgetSession: () => forgotten++,
    remainingMs: () => remaining,
    onChange: (s) => states.push(s),
    onTimeUpDone: () => done++,
    sleep: () => Promise.resolve(),
    timers: {
      setInterval: (fn: () => void) => (intervals.set(++n, fn), n),
      clearInterval: (h: unknown) => void intervals.delete(h as number),
    },
  });
  return {
    saver,
    presence,
    lifecycle,
    saves,
    states,
    get forgotten() {
      return forgotten;
    },
    get done() {
      return done;
    },
    setOnline: (v: boolean) => (online = v),
    /** The deadline passes and the lifecycle's own timer ticks. */
    async expire() {
      remaining = 0;
      for (const fn of intervals.values()) fn();
      await settle();
    },
    state: () => states.at(-1)!,
  };
}

test('broadcast supersede, then the deadline: no saves, no time-up, the shared copies survive', async () => {
  const storage = sharedStorage();
  const open = bus();
  const old = tab({ storage, open, id: 'old', online: true });
  old.saver.seed('q1', { clientSeq: 1, text: 'hello' });

  // The live tab is offline with unsent text in the shared mirror.
  const live = tab({ storage, open, id: 'live', online: false });
  live.saver.seed('q1', { clientSeq: 1, text: 'hello' });
  live.presence.announceTakeover();
  live.saver.update('q1', 'hello world', 6);
  await settle();

  assert.equal(old.state().phase, 'superseded');
  assert.equal(old.saver.status$.get(), 'superseded', 'the autosaver is stopped, not just hidden');
  assert.equal(old.forgotten, 1, 'it forgets its own (dead) session id');

  old.saver.update('q1', 'typed in the old tab', 3);
  void old.saver.flush();
  await old.expire();

  assert.equal(old.saves.length, 0, 'the superseded tab sent nothing');
  assert.equal(old.done, 0, 'no time-up flow in the superseded tab');
  assert.notEqual(old.state().phase, 'timeup');
  assert.equal(JSON.parse(storage.getItem(KEY('q1'))!).text, 'hello world', "the live tab's copy is intact");
});

test('server SESSION_SUPERSEDED takes the same path: superseded tab never clears the shared copies', async () => {
  const storage = sharedStorage();
  const open = bus();
  const t = tab({ storage, open, id: 't', online: true });
  storage.setItem(KEY('q1'), JSON.stringify({ text: 'other tab', at: 1, seq: 9, typed: 0, since: 0 }));
  t.lifecycle.supersede();
  assert.equal(t.forgotten, 1);
  t.lifecycle.finishSubmitted();
  await t.expire();
  assert.equal(t.state().phase, 'superseded');
  assert.ok(storage.getItem(KEY('q1')), 'kept');
  assert.ok(t.forgotten >= 1, 'only its own session id is forgotten');
});

test('owner tab, offline at time-up: copy kept and the candidate is told', async () => {
  const storage = sharedStorage();
  const t = tab({ storage, open: bus(), id: 't', online: false });
  t.saver.seed('q1', { clientSeq: 1, text: 'a' });
  t.saver.update('q1', 'ab', 1);
  await t.expire();
  assert.equal(t.state().phase, 'timeup');
  assert.ok(t.state().timeUpNotice);
  assert.ok(storage.getItem(KEY('q1')), 'kept');
  assert.equal(t.done, 1);
});

test('owner tab, all saved at time-up: copies cleared', async () => {
  const storage = sharedStorage();
  const t = tab({ storage, open: bus(), id: 't', online: true });
  t.saver.seed('q1', { clientSeq: 1, text: 'a' });
  t.saver.update('q1', 'ab', 1);
  await t.expire();
  assert.equal(t.saves.at(-1)?.text, 'ab', 'final flush sent the text');
  assert.equal(t.state().phase, 'timeup');
  assert.equal(t.state().timeUpNotice, null);
  assert.equal(storage.getItem(KEY('q1')), null);
  assert.equal(t.done, 1);
});

test('a supersede during the final flush stops the time-up flow from clearing', async () => {
  const storage = sharedStorage();
  const open = bus();
  const t = tab({ storage, open, id: 't', online: true });
  t.saver.seed('q1', { clientSeq: 1, text: 'a' });
  storage.setItem(KEY('other'), 'x');
  const p = t.lifecycle.timeUp();
  t.lifecycle.supersede();
  await p;
  await settle();
  assert.equal(t.state().phase, 'superseded');
  assert.equal(t.done, 0);
});
