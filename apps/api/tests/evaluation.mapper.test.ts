// Blind marking (design §8, plan Review Focus): the Evaluator payloads are
// whitelisted in the mapper, so even a source row stuffed with identity and
// location fields yields no PII. Deep key scan over the whole output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMarkingView, toSubmissionView, type MarkingSource, type SubmissionSource } from '../src/modules/evaluation/evaluation.mapper.js';

const FORBIDDEN = ['fullName', 'email', 'mobile', 'rollNumber', 'majorCpi', 'xPercentage', 'xiiPercentage', 'programme', 'discipline', 'latitude', 'longitude', 'ip', 'candidateId'];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object' && !(v instanceof Date)) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysDeep(x, out);
    }
  }
  return out;
}

const candidate = {
  id: 'c-1',
  candidateId: 'c-1',
  candidateCode: 'ARH-EX-000001',
  fullName: 'Ajith K K',
  email: 'ajith@example.com',
  mobile: '9876543210',
  rollNumber: '254101009',
  xPercentage: 97.6,
  xiiPercentage: 99.8,
  majorCpi: 8.67,
  programme: 'M.Tech',
  discipline: 'CSE',
  latitude: 26.19,
  longitude: 91.69,
  ip: '203.0.113.7',
  // Other registrations of the same person must never reach an evaluator.
  registrations: [{ examName: 'Other Hiring Exam', entries: [{ roundNumber: 1, status: 'REJECTED', totalMarks: 3 }] }],
};

const t0 = new Date('2026-10-01T10:00:00Z');
const t1 = new Date('2026-10-01T10:45:30Z');

const submission = {
  attemptId: 'a-1',
  startedAt: t0,
  submittedAt: t1,
  submitType: 'AUTO',
  totalMarks: null,
  startIp: '203.0.113.7',
  evaluation: { status: 'DRAFT', evaluatorId: 'adm-1' },
  candidate,
  round: {
    roundNumber: 2,
    exam: { name: 'Backend Hiring Nov 2026', jobRole: { name: 'Backend Engineer' }, registrations: [{ candidateId: 'c-9' }] },
    entries: [{ id: 'e-other', status: 'SHORTLISTED' }],
  },
  flags: { pasteAttempts: 1, bulkInsert: 0, ipChanges: 0, locationFlags: 2, excessiveTabSwitching: 0 },
  loginLogs: [{ latitude: 26.19, longitude: 91.69, ip: '203.0.113.7' }],
} as unknown as SubmissionSource;

const marking = {
  ...submission,
  questions: [
    {
      id: 'aq-1',
      order: 1,
      textSnapshot: 'Explain idempotency.',
      maxMarksSnapshot: 10,
      question: { evaluatorGuidance: 'Mentions retries', email: 'leak@example.com' },
      answer: { text: 'An operation...', wordCount: 2, versions: [{ savedAt: t0, wordCount: 1, text: 'An', ip: '1.1.1.1' }] },
      evaluation: { marks: 7.5, comment: 'Good', evaluatorId: 'adm-1' },
    },
  ],
  activity: [
    { eventType: 'PASTE_ATTEMPT', questionId: 'aq-1', createdAt: t0, metadata: { latitude: 1 }, ip: '1.1.1.1' },
    { eventType: 'SUSPICIOUS_BULK_INSERT', questionId: 'aq-1', createdAt: t1, metadata: { grown: 400, typed: 3, rate: 1, ip: 'x' }, ip: '1.1.1.1' },
    { eventType: 'TAB_HIDDEN', questionId: null, createdAt: t1, metadata: {}, ip: '1.1.1.1' },
  ],
} as unknown as MarkingSource;

test('evaluator payload has no PII keys', () => {
  for (const out of [toSubmissionView(submission, 'EVALUATOR'), toMarkingView(marking, 'EVALUATOR')]) {
    const keys = keysDeep(out);
    const leaked = FORBIDDEN.filter((k) => keys.has(k));
    assert.deepEqual(leaked, [], `leaked: ${leaked.join(', ')}`);
    assert.ok(!JSON.stringify(out).includes('ajith@example.com'));
    assert.ok(!JSON.stringify(out).includes('Ajith'));
  }
});

test('evaluator view has examName/roundNumber and no other registrations', () => {
  for (const out of [toSubmissionView(submission, 'EVALUATOR'), toMarkingView(marking, 'EVALUATOR')]) {
    assert.equal(out.examName, 'Backend Hiring Nov 2026');
    assert.equal(out.roundNumber, 2);
    assert.equal(out.jobRole, 'Backend Engineer');
    const keys = keysDeep(out);
    for (const k of ['registrations', 'entries', 'round', 'exam', 'status']) assert.ok(!keys.has(k), k);
    const json = JSON.stringify(out);
    assert.ok(!json.includes('Other Hiring Exam'), 'another registration leaked');
    assert.ok(!json.includes('e-other') && !json.includes('c-9'), 'another entry leaked');
  }
});

test('super admin gets PII but never location', () => {
  for (const out of [toSubmissionView(submission, 'SUPER_ADMIN'), toMarkingView(marking, 'SUPER_ADMIN')]) {
    const keys = keysDeep(out);
    assert.ok(keys.has('fullName'));
    assert.ok(keys.has('candidateId'));
    for (const k of ['latitude', 'longitude', 'ip', 'mobile']) assert.ok(!keys.has(k), k);
  }
});

test('submission view shape', () => {
  assert.deepEqual(toSubmissionView(submission, 'EVALUATOR'), {
    attemptId: 'a-1',
    candidateCode: 'ARH-EX-000001',
    jobRole: 'Backend Engineer',
    examName: 'Backend Hiring Nov 2026',
    roundNumber: 2,
    submittedAt: t1.toISOString(),
    timeTakenSec: 2730,
    submitType: 'AUTO',
    flagCounts: { pasteAttempts: 1, bulkInsert: 0, ipChanges: 0, locationFlags: 2, excessiveTabSwitching: 0 },
    evaluationStatus: 'DRAFT',
    totalMarks: null,
  });
});

test('marking view: per-question answer, versions, integrity and evaluation', () => {
  const v = toMarkingView(marking, 'EVALUATOR');
  assert.equal(v.evaluationStatus, 'DRAFT');
  assert.deepEqual(v.questions, [
    {
      attemptQuestionId: 'aq-1',
      order: 1,
      text: 'Explain idempotency.',
      maxMarks: 10,
      evaluatorGuidance: 'Mentions retries',
      answer: { text: 'An operation...', wordCount: 2, versions: [{ savedAt: t0.toISOString(), wordCount: 1 }] },
      integrity: { pasteAttempts: 1, bulkInsert: [{ at: t1.toISOString(), grown: 400, typed: 3 }] },
      evaluation: { marks: 7.5, comment: 'Good' },
    },
  ]);
});

test('evaluation status: no row or never saved is PENDING', () => {
  assert.equal(toSubmissionView({ ...submission, evaluation: null }, 'EVALUATOR').evaluationStatus, 'PENDING');
  assert.equal(toSubmissionView({ ...submission, evaluation: { status: 'DRAFT', evaluatorId: null } }, 'EVALUATOR').evaluationStatus, 'PENDING');
  assert.equal(toSubmissionView({ ...submission, evaluation: { status: 'SUBMITTED', evaluatorId: 'x' } }, 'EVALUATOR').evaluationStatus, 'SUBMITTED');
});

test('timeline: whitelisted exam events in order, with question number and bulk numbers only', () => {
  const src = {
    ...marking,
    activity: [
      ...(marking as unknown as { activity: unknown[] }).activity,
      { eventType: 'IP_CHANGED', questionId: null, createdAt: t1, metadata: { from: '203.0.113.7', to: '198.51.100.9' }, ip: '198.51.100.9' },
      { eventType: 'OTP_VERIFIED', questionId: null, createdAt: t1, metadata: {}, ip: '1.1.1.1' },
      { eventType: 'QUESTION_VIEWED', questionId: 'aq-unknown', createdAt: t1, metadata: {}, ip: '1.1.1.1' },
    ],
  } as unknown as MarkingSource;
  for (const role of ['EVALUATOR', 'SUPER_ADMIN'] as const) {
    const out = toMarkingView(src, role);
    assert.equal(out.startedAt, t0.toISOString());
    assert.deepEqual(out.timeline, [
      { at: t0.toISOString(), type: 'PASTE_ATTEMPT', questionOrder: 1, bulk: null },
      { at: t1.toISOString(), type: 'SUSPICIOUS_BULK_INSERT', questionOrder: 1, bulk: { grown: 400, typed: 3 } },
      { at: t1.toISOString(), type: 'TAB_HIDDEN', questionOrder: null, bulk: null },
      { at: t1.toISOString(), type: 'IP_CHANGED', questionOrder: null, bulk: null },
      { at: t1.toISOString(), type: 'QUESTION_VIEWED', questionOrder: null, bulk: null },
    ]);
    const json = JSON.stringify(out.timeline);
    assert.ok(!json.includes('203.0.113.7') && !json.includes('198.51.100.9'), 'IP addresses never reach the timeline');
  }
});
