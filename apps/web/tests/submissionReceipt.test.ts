import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptRows, timeTaken } from '../src/lib/submissionReceipt.js';

const candidate = { fullName: 'Aswajith K K', candidateCode: 'ARH-EX-000123', jobRole: { name: 'AI & ML Engineer' } };
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
  assert.equal(rows['Candidate code'], 'ARH-EX-000123');
  assert.equal(rows['Job role'], 'AI & ML Engineer');
  assert.equal(rows['Submission'], 'Submitted by you');
  assert.equal(rows['Questions'], '8 of 10 answered');
  assert.equal(rows['Time taken'], '52 min 30 s');
  assert.match(rows['Submitted at']!, /01 Nov 2026/);
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
