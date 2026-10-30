import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerClock } from '../src/lib/serverClock.js';

test('remainingMs ignores a skewed local clock', () => {
  const T = Date.parse('2026-11-01T10:00:00.000Z');
  // The device clock is 5 minutes ahead of the server.
  const localAtReceive = T + 5 * 60_000;
  let local = localAtReceive;
  const clock = createServerClock(new Date(T).toISOString(), localAtReceive, () => local);
  const endsAt = new Date(T + 60_000).toISOString();
  assert.ok(Math.abs(clock.remainingMs(endsAt) - 60_000) <= 50);
  local += 20_000;
  assert.ok(Math.abs(clock.remainingMs(endsAt) - 40_000) <= 50);
  assert.equal(clock.now(), T + 20_000);
});

test('remainingMs never goes below 0', () => {
  const T = Date.parse('2026-11-01T10:00:00.000Z');
  let local = 1_000;
  const clock = createServerClock(new Date(T).toISOString(), 1_000, () => local);
  const endsAt = new Date(T + 10_000).toISOString();
  local += 60_000;
  assert.equal(clock.remainingMs(endsAt), 0);
});
