import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptRows, selectionLabel, timeTaken } from '../src/lib/submissionReceipt.js';

const candidate = {
  fullName: 'Aswajith K K',
  email: 'k.aswajith@iitg.ac.in',
  candidateCode: 'ARH-EX-000123',
  jobRole: { name: 'AI & ML Engineer' },
  selectedForNextRound: 'AWAITED' as const,
};
const summary = {
  status: 'SUBMITTED' as const,
  submitType: 'MANUAL' as const,
  startedAt: '2026-11-01T09:00:00.000Z',
  submittedAt: '2026-11-01T09:52:30.000Z',
  questionCount: 10,
  answeredCount: 8,
};

test('receipt rows for a manual submission', () => {
  const rows = Object.fromEntries(receiptRows(candidate, summary).map((r) => [r.label, r.value]));
  assert.equal(rows['Name'], 'Aswajith K K');
  assert.equal(rows['Email'], 'k.aswajith@iitg.ac.in');
  assert.equal(rows['Exam code'], 'ARH-EX-000123');
  assert.equal(rows['Job profile'], 'AI & ML Engineer');
  assert.equal(rows['Submission'], 'Submitted by you');
  assert.equal(rows['Questions'], '8 of 10 answered');
  assert.equal(rows['Time taken'], '52 min 30 s');
  assert.match(rows['Started at']!, /01 Nov 2026/);
  assert.match(rows['Submitted at']!, /01 Nov 2026/);
  assert.equal(rows['Selected for next round'], 'Result awaited');
  assert.equal(rows['Result'], undefined, 'the old Result row is replaced');
});

test('selected for next round: Yes when shortlisted, No when rejected, Result awaited otherwise', () => {
  assert.equal(selectionLabel('YES'), 'Yes');
  assert.equal(selectionLabel('NO'), 'No');
  assert.equal(selectionLabel('AWAITED'), 'Result awaited');
  const row = (v: 'YES' | 'NO' | 'AWAITED') =>
    receiptRows({ ...candidate, selectedForNextRound: v }, summary).find((r) => r.label === 'Selected for next round')?.value;
  assert.deepEqual([row('YES'), row('NO'), row('AWAITED')], ['Yes', 'No', 'Result awaited']);
});

test('auto-submitted wording and missing times', () => {
  const rows = Object.fromEntries(
    receiptRows(candidate, { ...summary, status: 'AUTO_SUBMITTED', submitType: 'AUTO', submittedAt: null }).map((r) => [r.label, r.value]),
  );
  assert.equal(rows['Submission'], 'Auto-submitted when time was up');
  assert.equal(rows['Submitted at'], '-');
  assert.equal(rows['Time taken'], '-');
});

test('timeTaken formats hours and never goes negative', () => {
  assert.equal(timeTaken('2026-11-01T09:00:00Z', '2026-11-01T10:05:00Z'), '1 h 5 min');
  assert.equal(timeTaken('2026-11-01T09:00:00Z', '2026-11-01T09:00:40Z'), '40 s');
  assert.equal(timeTaken('2026-11-01T09:00:00Z', '2026-11-01T08:00:00Z'), '0 s');
});
