import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, formatDuration, formatElapsed, summarize } from '../src/lib/examTimeline.js';

const START = '2026-11-01T10:00:00.000Z';
const at = (sec: number) => new Date(Date.parse(START) + sec * 1000).toISOString();
const ev = (sec: number, type: string, questionOrder: number | null = null, bulk: { grown: number; typed: number } | null = null) => ({
  at: at(sec),
  type,
  questionOrder,
  bulk,
});

test('rows carry label, severity, time into the exam and the question', () => {
  const rows = buildTimeline([ev(0, 'EXAM_STARTED'), ev(65, 'PASTE_ATTEMPT', 2)], START);
  assert.equal(rows[0]!.label, 'Exam started');
  assert.equal(rows[0]!.severity, 'info');
  assert.equal(rows[1]!.label, 'Paste attempt blocked');
  assert.equal(rows[1]!.severity, 'flag');
  assert.equal(rows[1]!.sinceStartMs, 65_000);
  assert.equal(rows[1]!.questionOrder, 2);
});

test('a return closes the matching away period: tab, focus and network each pair separately', () => {
  const rows = buildTimeline(
    [ev(10, 'WINDOW_BLUR'), ev(11, 'TAB_HIDDEN'), ev(91, 'TAB_VISIBLE'), ev(92, 'WINDOW_FOCUS'), ev(200, 'NETWORK_OFFLINE'), ev(230, 'NETWORK_ONLINE')],
    START,
  );
  assert.deepEqual(
    rows.map((r) => r.awayMs),
    [null, null, 80_000, 82_000, null, 30_000],
  );
});

test('a return without an earlier away event has no duration', () => {
  assert.equal(buildTimeline([ev(5, 'TAB_VISIBLE')], START)[0]!.awayMs, null);
});

test('bulk insert detail and unknown event types fall back safely', () => {
  const rows = buildTimeline([ev(30, 'SUSPICIOUS_BULK_INSERT', 1, { grown: 420, typed: 4 }), ev(31, 'SOMETHING_NEW')], START);
  assert.equal(rows[0]!.detail, 'answer grew 420 chars, 4 typed');
  assert.equal(rows[1]!.label, 'SOMETHING_NEW');
  assert.equal(rows[1]!.severity, 'info');
});

test('events before the recorded start never show a negative offset', () => {
  assert.equal(buildTimeline([ev(-3, 'SESSION_TAKEOVER')], START)[0]!.sinceStartMs, 0);
});

test('summary counts flags before warnings and skips info events', () => {
  const rows = buildTimeline(
    [ev(1, 'TAB_HIDDEN'), ev(2, 'TAB_VISIBLE'), ev(3, 'TAB_HIDDEN'), ev(4, 'PASTE_ATTEMPT', 1), ev(5, 'EXAM_SUBMITTED')],
    START,
  );
  assert.deepEqual(summarize(rows), [
    { label: 'Paste attempt blocked', severity: 'flag', count: 1 },
    { label: 'Left the exam tab', severity: 'warn', count: 2 },
  ]);
});

test('formatting', () => {
  assert.equal(formatElapsed(307_000), '+05:07');
  assert.equal(formatElapsed(3_907_000), '+1:05:07');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(200_000), '3m 20s');
  assert.equal(formatDuration(3_720_000), '1h 02m');
});
