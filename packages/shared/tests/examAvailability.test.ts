import { test } from 'node:test';
import assert from 'node:assert/strict';
import { examAvailability } from '../src/examAvailability.js';

const start = new Date('2026-11-01T04:00:00Z');
const end = new Date('2026-11-01T10:00:00Z');
const mid = new Date('2026-11-01T06:00:00Z');

test('examAvailability', () => {
  assert.equal(examAvailability({ isOpen: false, windowStart: null, windowEnd: null }, mid), 'NOT_OPEN');
  assert.equal(examAvailability({ isOpen: false, windowStart: start, windowEnd: end }, mid), 'NOT_OPEN');
  assert.equal(examAvailability({ isOpen: true, windowStart: start, windowEnd: end }, new Date('2026-11-01T03:00:00Z')), 'BEFORE_WINDOW');
  assert.equal(examAvailability({ isOpen: true, windowStart: start, windowEnd: end }, new Date('2026-11-01T11:00:00Z')), 'AFTER_WINDOW');
  assert.equal(examAvailability({ isOpen: true, windowStart: start, windowEnd: end }, mid), 'OPEN');
  assert.equal(examAvailability({ isOpen: true, windowStart: null, windowEnd: null }, mid), 'OPEN');
  assert.equal(examAvailability({ isOpen: true, windowStart: start.toISOString(), windowEnd: null }, mid), 'OPEN');
  assert.equal(examAvailability({ isOpen: true, windowStart: start, windowEnd: end }, start), 'OPEN');
  assert.equal(examAvailability({ isOpen: true, windowStart: start, windowEnd: end }, end), 'OPEN');
});
