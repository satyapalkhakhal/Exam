import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoToIstInput, istInputToIso, formatIst } from '../src/lib/istTime.js';
import { examAvailability } from '@exam/shared';

test('ISO UTC to IST datetime-local', () => {
  assert.equal(isoToIstInput('2026-11-01T04:30:00.000Z'), '2026-11-01T10:00');
  assert.equal(isoToIstInput(null), '');
});

test('IST datetime-local to ISO UTC', () => {
  assert.equal(istInputToIso('2026-11-01T10:00'), '2026-11-01T04:30:00.000Z');
  assert.equal(istInputToIso(''), null);
});

test('round trip across midnight', () => {
  const iso = '2026-11-01T19:00:00.000Z';
  assert.equal(isoToIstInput(iso), '2026-11-02T00:30');
  assert.equal(istInputToIso(isoToIstInput(iso)), iso);
});

test('formatIst is IST', () => {
  assert.match(formatIst('2026-11-01T04:30:00.000Z'), /10:00/);
});

test('examAvailability', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const s = { isOpen: true, windowStart: null, windowEnd: null };
  assert.equal(examAvailability({ ...s, isOpen: false }, now), 'NOT_OPEN');
  assert.equal(examAvailability(s, now), 'OPEN');
  assert.equal(examAvailability({ ...s, windowStart: '2026-11-02T00:00:00Z' }, now), 'BEFORE_WINDOW');
  assert.equal(examAvailability({ ...s, windowEnd: '2026-11-01T00:00:00Z' }, now), 'AFTER_WINDOW');
});
