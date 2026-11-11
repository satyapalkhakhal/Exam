import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutosaver,
  shouldRestoreMirror,
  type Autosaver,
  type MirrorRecord,
  type SavePayload,
  type SaveResult,
  type SaveStatus,
} from '../src/lib/autosave.js';

// ---- fakes -----------------------------------------------------------------

function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    /** Advance time, firing due timers in order, letting promise callbacks run between them. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const e of pending) if (e[1].at <= end && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

function memStorage() {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

interface Deferred {
  payload: SavePayload;
  resolve: (r: SaveResult) => void;
  reject: (e: unknown) => void;
}

/** A save() whose calls are recorded and settled by the test. */
function fakeSave() {
  const calls: Deferred[] = [];
  const save = (payload: SavePayload) =>
    new Promise<SaveResult>((resolve, reject) => calls.push({ payload, resolve, reject }));
  return { calls, save };
}

const ACCEPTED: SaveResult = { accepted: true, serverNow: '2026-11-01T10:00:00.000Z', lastSavedAt: '2026-11-01T10:00:00.000Z' };
const apiError = (code: string, status: number) => Object.assign(new Error(code), { code, status });
const KEY = (id: string) => `exam:att1:${id}`;

function setup() {
  const clock = fakeClock();
  const storage = memStorage();
  const fs = fakeSave();
  const statuses: SaveStatus[] = [];
  const server = { text: '', clientSeq: 0, fail: false, calls: 0 };
  const saver: Autosaver = createAutosaver({
    save: fs.save,
    resolveStale: async () => {
      server.calls++;
      if (server.fail) throw new TypeError('Failed to fetch');
      return { text: server.text, clientSeq: server.clientSeq };
    },
    debounceMs: 2000,
    storage,
    key: KEY,
    now: clock.now,
    timers: clock.timers,
  });
  saver.status$.subscribe((s) => statuses.push(s));
  const status = () => statuses.at(-1);
  const mirror = (id = 'q1') => {
    const raw = storage.getItem(KEY(id));
    return raw ? (JSON.parse(raw) as MirrorRecord) : null;
  };
  return { clock, storage, fs, saver, status, mirror, server };
}

// ---- tests -----------------------------------------------------------------

test('3 updates within 2 s -> one save with clientSeq 1 and the latest text', async () => {
  const { clock, fs, saver } = setup();
  saver.update('q1', 'a', 1);
  await clock.advance(500);
  saver.update('q1', 'ab', 1);
  await clock.advance(500);
  saver.update('q1', 'abc', 1);
  await clock.advance(1999);
  assert.equal(fs.calls.length, 0);
  await clock.advance(1);
  assert.equal(fs.calls.length, 1);
  assert.equal(fs.calls[0]!.payload.clientSeq, 1);
  assert.equal(fs.calls[0]!.payload.text, 'abc');
  assert.equal(fs.calls[0]!.payload.typedChars, 3);
  assert.equal(fs.calls[0]!.payload.attemptQuestionId, 'q1');
});

test('network failure -> offline with mirror kept; retry after 1 s succeeds -> saved, mirror cleared', async () => {
  const { clock, fs, saver, status, mirror } = setup();
  saver.update('q1', 'hello', 5);
  assert.equal(mirror()?.text, 'hello', 'mirrored as soon as it is typed');
  await clock.advance(2000);
  assert.equal(status(), 'saving');
  fs.calls[0]!.reject(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(status(), 'offline');
  assert.equal(mirror()?.text, 'hello');

  await clock.advance(999);
  assert.equal(fs.calls.length, 1);
  await clock.advance(1);
  assert.equal(fs.calls.length, 2, 'retried after 1 s');
  assert.equal(fs.calls[1]!.payload.clientSeq, 2, 'every send gets a new clientSeq');
  fs.calls[1]!.resolve(ACCEPTED);
  await settle();
  assert.equal(status(), 'saved');
  assert.equal(mirror(), null);
});

test('backoff is 1, 2, 4, 8, 15, 15 s and keeps retrying', async () => {
  const { clock, fs, saver } = setup();
  saver.update('q1', 'x', 1);
  await clock.advance(2000);
  const gaps = [1000, 2000, 4000, 8000, 15000, 15000];
  for (const gap of gaps) {
    const n = fs.calls.length;
    fs.calls[n - 1]!.reject(new TypeError('Failed to fetch'));
    await clock.advance(gap - 1);
    assert.equal(fs.calls.length, n, `not before ${gap} ms`);
    await clock.advance(1);
    assert.equal(fs.calls.length, n + 1, `retried at ${gap} ms`);
  }
});

test('SESSION_SUPERSEDED -> superseded, and further updates never call save', async () => {
  const { clock, fs, saver, status } = setup();
  saver.update('q1', 'a', 1);
  await clock.advance(2000);
  fs.calls[0]!.reject(apiError('SESSION_SUPERSEDED', 409));
  await settle();
  assert.equal(status(), 'superseded');
  saver.update('q1', 'ab', 1);
  await clock.advance(60_000);
  await saver.flush();
  assert.equal(fs.calls.length, 1);
  assert.equal(status(), 'superseded');
});

test('ATTEMPT_LOCKED -> locked, and stops', async () => {
  const { clock, fs, saver, status } = setup();
  saver.update('q1', 'a', 1);
  await clock.advance(2000);
  fs.calls[0]!.reject(apiError('ATTEMPT_LOCKED', 409));
  await settle();
  assert.equal(status(), 'locked');
  saver.update('q1', 'ab', 1);
  await clock.advance(60_000);
  assert.equal(fs.calls.length, 1);
});

test('typedChars and intervalMs carry over after a failed save', async () => {
  const { clock, fs, saver } = setup();
  saver.update('q1', 'abc', 3);
  await clock.advance(2000);
  assert.equal(fs.calls[0]!.payload.typedChars, 3);
  assert.equal(fs.calls[0]!.payload.intervalMs, 2000);
  fs.calls[0]!.reject(new TypeError('Failed to fetch'));
  await settle();
  saver.update('q1', 'abcd', 1);
  await clock.advance(1000);
  assert.equal(fs.calls[1]!.payload.typedChars, 4, 'failed count carried over');
  assert.equal(fs.calls[1]!.payload.intervalMs, 3000, 'interval runs from the last accepted save');
  fs.calls[1]!.resolve(ACCEPTED);
  await settle();

  saver.update('q1', 'abcde', 1);
  await clock.advance(2000);
  assert.equal(fs.calls[2]!.payload.typedChars, 1, 'reset after an accepted save');
  assert.equal(fs.calls[2]!.payload.intervalMs, 2000);
});

test('flush() sends immediately and resolves once settled', async () => {
  const { clock, fs, saver, status } = setup();
  saver.update('q1', 'abc', 3);
  const done = saver.flush();
  await settle();
  assert.equal(fs.calls.length, 1);
  let resolved = false;
  void done.then(() => (resolved = true));
  await settle();
  assert.equal(resolved, false, 'waits for the in-flight save');
  fs.calls[0]!.resolve(ACCEPTED);
  await done;
  assert.equal(status(), 'saved');
  await clock.advance(5000);
  assert.equal(fs.calls.length, 1, 'the debounce timer was cancelled');
});

test('STALE counts as saved only when the server holds exactly the text we sent', async () => {
  const { clock, fs, saver, status, mirror, server } = setup();
  saver.update('q1', 'abc', 3);
  await clock.advance(2000);
  server.text = 'abc';
  server.clientSeq = 7;
  fs.calls[0]!.resolve({ accepted: false, reason: 'STALE' });
  await settle();
  assert.equal(server.calls, 1, 'asked the server what it holds');
  assert.equal(status(), 'saved');
  assert.equal(mirror(), null);
  assert.equal(fs.calls.length, 1);
});

test('STALE with different server text: mirror kept, not saved, resent above the server clientSeq', async () => {
  const { clock, fs, saver, status, mirror, server } = setup();
  saver.update('q1', 'mine', 4);
  await clock.advance(2000);
  server.text = 'someone else';
  server.clientSeq = 9;
  fs.calls[0]!.resolve({ accepted: false, reason: 'STALE' });
  await settle();
  assert.notEqual(status(), 'saved');
  assert.equal(mirror()?.text, 'mine', 'local copy kept');
  assert.equal(fs.calls.length, 2, 'resent at once');
  assert.equal(fs.calls[1]!.payload.text, 'mine');
  assert.equal(fs.calls[1]!.payload.clientSeq, 10);
  assert.equal(fs.calls[1]!.payload.typedChars, 4, 'typed evidence not consumed by a STALE');
  fs.calls[1]!.resolve(ACCEPTED);
  await settle();
  assert.equal(status(), 'saved');
  assert.equal(mirror(), null);
});

test('STALE whose resolution fails is retried like any failed save, mirror kept', async () => {
  const { clock, fs, saver, status, mirror, server } = setup();
  saver.update('q1', 'mine', 4);
  await clock.advance(2000);
  server.fail = true;
  fs.calls[0]!.resolve({ accepted: false, reason: 'STALE' });
  await settle();
  assert.equal(status(), 'offline');
  assert.equal(mirror()?.text, 'mine');
  server.fail = false;
  server.text = 'other';
  server.clientSeq = 3;
  await clock.advance(1000);
  assert.equal(fs.calls.length, 2, 'retried after the backoff');
  fs.calls[1]!.resolve({ accepted: false, reason: 'STALE' });
  await settle();
  assert.equal(fs.calls.length, 3, 'resolved this time, so resent');
  assert.ok(fs.calls[2]!.payload.clientSeq > 3, 'above the server clientSeq');
  assert.equal(mirror()?.text, 'mine');
});

test('typing while a retry is in flight is always sent after it (no stuck "Saving…")', async () => {
  const { clock, fs, saver, status } = setup();
  saver.update('q1', 'a', 1);
  await clock.advance(2000);
  fs.calls[0]!.reject(new TypeError('Failed to fetch'));
  await clock.advance(1000);
  assert.equal(fs.calls.length, 2, 'retry in flight');
  saver.update('q1', 'ab', 1);
  await clock.advance(2000); // debounce fires while the retry is still in flight
  fs.calls[1]!.resolve(ACCEPTED);
  await clock.advance(120_000);
  assert.equal(fs.calls.length, 3, 'the newer text was sent');
  assert.equal(fs.calls[2]!.payload.text, 'ab');
  fs.calls[2]!.resolve(ACCEPTED);
  await settle();
  assert.equal(status(), 'saved');
  assert.equal(saver.hasUnsaved(), false);
});

test('typing while a retry is in flight, retry acked before the debounce fires', async () => {
  const { clock, fs, saver, status } = setup();
  saver.update('q1', 'a', 1);
  await clock.advance(2000);
  fs.calls[0]!.reject(new TypeError('Failed to fetch'));
  await clock.advance(1000);
  saver.update('q1', 'ab', 1);
  fs.calls[1]!.resolve(ACCEPTED);
  await clock.advance(120_000);
  assert.equal(fs.calls.length, 3);
  assert.equal(fs.calls[2]!.payload.text, 'ab');
  fs.calls[2]!.resolve(ACCEPTED);
  await settle();
  assert.equal(status(), 'saved');
});

test('overlapping saves: an older text is never acknowledged as the latest', async () => {
  const { fs, saver, status, mirror } = setup();
  saver.update('q1', 'old', 3);
  void saver.flush('q1');
  await settle();
  saver.update('q1', 'old and new', 8);
  const second = saver.flush('q1');
  await settle();
  assert.equal(fs.calls.length, 1, 'never two saves in flight for one question');

  // The older save is acknowledged while newer text is waiting.
  fs.calls[0]!.resolve(ACCEPTED);
  await settle();
  assert.notEqual(status(), 'saved', 'still saving the newer text');
  assert.equal(mirror()?.text, 'old and new', 'the newer text stays mirrored');
  assert.equal(fs.calls.length, 2);
  assert.equal(fs.calls[1]!.payload.text, 'old and new');
  assert.ok(fs.calls[1]!.payload.clientSeq > fs.calls[0]!.payload.clientSeq);
  assert.equal(fs.calls[1]!.payload.typedChars, 8, 'only the chars not yet accepted');

  fs.calls[1]!.resolve(ACCEPTED);
  await second;
  assert.equal(status(), 'saved');
  assert.equal(mirror(), null);
});

test('a late ack of an old save does not clear the mirror of newer, unsent text', async () => {
  const { fs, saver, mirror } = setup();
  saver.update('q1', 'v1', 2);
  void saver.flush('q1');
  await settle();
  saver.update('q1', 'v1 v2', 3); // debounced, not yet sent
  fs.calls[0]!.resolve(ACCEPTED);
  await settle();
  assert.equal(mirror()?.text, 'v1 v2');
});

test('seed() continues clientSeq from the server so a reload is never STALE', async () => {
  const { fs, saver, status } = setup();
  saver.seed('q1', { clientSeq: 41, text: 'server text' });
  assert.equal(status(), 'saved');
  saver.update('q1', 'server text!', 1);
  void saver.flush('q1');
  await settle();
  assert.equal(fs.calls[0]!.payload.clientSeq, 42);
});

test('flags (visited / markedForReview) ride along with a save', async () => {
  const { fs, saver } = setup();
  saver.seed('q1', { clientSeq: 0, text: '' });
  saver.setFlags('q1', { markedForReview: true });
  void saver.flush('q1');
  await settle();
  assert.equal(fs.calls[0]!.payload.markedForReview, true);
  assert.equal(fs.calls[0]!.payload.text, '');
});

test('flushBeacon sends unsaved text with a fresh clientSeq and records it in the mirror', async () => {
  const clock = fakeClock();
  const storage = memStorage();
  const fs = fakeSave();
  const beacons: SavePayload[] = [];
  const saver = createAutosaver({
    save: fs.save,
    beacon: (p) => (beacons.push(p), true),
    resolveStale: async () => ({ text: '', clientSeq: 0 }),
    debounceMs: 2000,
    storage,
    key: KEY,
    now: clock.now,
    timers: clock.timers,
  });
  saver.seed('q1', { clientSeq: 5, text: 'a' });
  saver.seed('q2', { clientSeq: 2, text: 'saved' });
  saver.update('q1', 'ab', 1);
  saver.flushBeacon();
  assert.equal(beacons.length, 1, 'only questions with unsaved text');
  assert.equal(beacons[0]!.clientSeq, 6);
  assert.equal(beacons[0]!.text, 'ab');
  assert.equal((JSON.parse(storage.getItem(KEY('q1'))!) as MirrorRecord).seq, 6);
});

// ---- restore decision --------------------------------------------------------

const m = (over: Partial<MirrorRecord>): MirrorRecord => ({ text: 'local', at: 2_000, seq: 3, typed: 0, since: 1_000, ...over });
const server = (over: Partial<{ text: string; clientSeq: number; lastSavedAt: string | null }> = {}) => ({
  text: 'server',
  clientSeq: 3,
  lastSavedAt: new Date(1_500).toISOString(),
  ...over,
});

test('shouldRestoreMirror', () => {
  assert.equal(shouldRestoreMirror(null, server()), false, 'no mirror');
  assert.equal(shouldRestoreMirror(m({ text: 'server' }), server()), false, 'same text');
  assert.equal(shouldRestoreMirror(m({ seq: 4 }), server()), true, 'never acknowledged');
  assert.equal(shouldRestoreMirror(m({ seq: 2 }), server()), false, 'server has a newer accepted save');
  assert.equal(shouldRestoreMirror(m({ at: 2_000 }), server()), true, 'typed after the last accepted save');
  assert.equal(
    shouldRestoreMirror(m({ at: 1_000, text: 'x' }), server({ lastSavedAt: new Date(1_500).toISOString() })),
    false,
    'older and shorter than the server copy',
  );
  assert.equal(shouldRestoreMirror(m({ seq: 0 }), server({ clientSeq: 0, lastSavedAt: null, text: '' })), true, 'never saved');
});

test('I4: Undo/Redo characters go as restoredChars, separate from typedChars, and reset once accepted', async () => {
  const { clock, fs, saver } = setup();
  saver.update('q1', 'abc', 3);
  saver.update('q1', 'abcdefghij', 0, 7);
  await clock.advance(2000);
  assert.equal(fs.calls[0]!.payload.typedChars, 3);
  assert.equal(fs.calls[0]!.payload.restoredChars, 7);
  fs.calls[0]!.resolve(ACCEPTED);
  await settle();
  saver.update('q1', 'abcdefghijk', 1);
  await clock.advance(2000);
  assert.equal(fs.calls[1]!.payload.restoredChars, 0);
});

test('choice path: an MCQ choice is saved at once on flush, latest choice wins, clearing sends an empty value', async () => {
  const clock = fakeClock();
  const storage = memStorage();
  const sent: SavePayload[] = [];
  const saver = createAutosaver({
    save: async (p) => {
      sent.push(p);
      return { accepted: true, serverNow: new Date(clock.now()).toISOString(), lastSavedAt: new Date(clock.now()).toISOString() };
    },
    debounceMs: 2000,
    storage,
    key: (id) => `k:${id}`,
    now: clock.now,
    timers: clock.timers,
    resolveStale: async () => ({ text: '', clientSeq: 0 }),
  });
  saver.seed('m1', { clientSeq: 0, text: '' });
  saver.update('m1', '1', 0);
  saver.update('m1', '3', 0);
  await saver.flush('m1');
  assert.equal(sent.length, 1, 'one save, no debounce wait');
  assert.deepEqual([sent[0]!.text, sent[0]!.clientSeq, sent[0]!.typedChars], ['3', 1, 0]);
  saver.update('m1', '', 0);
  await saver.flush('m1');
  assert.deepEqual([sent[1]!.text, sent[1]!.clientSeq], ['', 2]);
  assert.equal(saver.hasUnsaved(), false);
  saver.dispose();
});
