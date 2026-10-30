import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdownTone, formatCountdown } from '../src/lib/countdown.js';
import { createEventQueue, type QueuedEvent } from '../src/lib/eventQueue.js';

test('formatCountdown is mm:ss, rounding up so 00:00 means time is really up', () => {
  assert.equal(formatCountdown(60 * 60_000), '60:00');
  assert.equal(formatCountdown(9 * 60_000 + 5_000), '09:05');
  assert.equal(formatCountdown(500), '00:01');
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(-10), '00:00');
});

test('countdownTone: amber under 10 min, red under 2 min', () => {
  assert.equal(countdownTone(10 * 60_000), 'normal');
  assert.equal(countdownTone(10 * 60_000 - 1), 'warning');
  assert.equal(countdownTone(2 * 60_000), 'warning');
  assert.equal(countdownTone(2 * 60_000 - 1), 'danger');
});

function manualTimers() {
  const fns = new Map<number, () => void>();
  let id = 0;
  return {
    timers: {
      setInterval: (fn: () => void) => (fns.set(++id, fn), id),
      clearInterval: (h: unknown) => void fns.delete(h as number),
    },
    tick: () => fns.forEach((f) => f()),
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};
const e = (n: number): QueuedEvent => ({ type: 'WINDOW_BLUR', at: new Date(n).toISOString() });

test('event queue sends in batches of at most 50 on each tick and requeues on failure', async () => {
  const sent: QueuedEvent[][] = [];
  let fail = true;
  const { timers, tick } = manualTimers();
  const q = createEventQueue({
    send: async (batch) => {
      if (fail) throw new TypeError('Failed to fetch');
      sent.push(batch);
    },
    beacon: () => {},
    intervalMs: 5000,
    timers,
  });
  q.start();
  for (let i = 0; i < 60; i++) q.push(e(i));
  tick();
  await settle();
  assert.equal(sent.length, 0);
  fail = false;
  tick();
  await settle();
  assert.deepEqual(sent.map((b) => b.length), [50, 10]);
  assert.equal(sent[0]![0]!.at, e(0).at, 'order kept after a failed send');
});

test('event queue beacon drains the queue; SESSION_SUPERSEDED stops it', async () => {
  const beacons: QueuedEvent[][] = [];
  let superseded = 0;
  const { timers, tick } = manualTimers();
  const q = createEventQueue({
    send: async () => {
      throw Object.assign(new Error('x'), { code: 'SESSION_SUPERSEDED' });
    },
    beacon: (b) => void beacons.push(b),
    onSuperseded: () => superseded++,
    intervalMs: 5000,
    timers,
  });
  q.start();
  q.push(e(1));
  q.flushBeacon();
  assert.equal(beacons[0]!.length, 1);
  q.push(e(2));
  tick();
  await settle();
  assert.equal(superseded, 1);
  q.push(e(3));
  q.flushBeacon();
  assert.equal(beacons.length, 1, 'stopped after superseded');
});

test('time-up keeps the local copies unless everything reached the server', async () => {
  const { timeUpOutcome, UNSAVED_AT_TIME_UP } = await import('../src/lib/examEnd.js');
  assert.deepEqual(timeUpOutcome({ status: 'saved', hasUnsaved: false }), { clearLocal: true, notice: null });
  for (const status of ['offline', 'error', 'saving', 'superseded', 'locked'] as const) {
    assert.deepEqual(timeUpOutcome({ status, hasUnsaved: true }), { clearLocal: false, notice: UNSAVED_AT_TIME_UP }, status);
  }
  // A superseded tab with nothing pending still must not wipe what the other window relies on.
  assert.equal(timeUpOutcome({ status: 'superseded', hasUnsaved: false }).clearLocal, false);
  assert.equal(timeUpOutcome({ status: 'saved', hasUnsaved: true }).clearLocal, false);
});
