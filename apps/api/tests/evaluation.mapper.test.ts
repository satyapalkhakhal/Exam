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
  jobRole: { name: 'Backend Engineer', type: 'INTERNSHIP' },
  drive: { batch: 'Nov 2026', round: { roundNumber: 2 }, college: { shortCode: 'IITG' } },
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
  questions: [],
  candidate,
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
      evaluation: { marks: 7.5, comment: 'Good', evaluatorId: 'adm-1', aiScoreId: null },
      aiScores: [],
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
    jobProfileType: 'INTERNSHIP',
    roundNumber: 2,
    submittedAt: t1.toISOString(),
    timeTakenSec: 2730,
    submitType: 'AUTO',
    mcqMarks: null,
    mcqMaxMarks: 0,
    flagCounts: { pasteAttempts: 1, bulkInsert: 0, ipChanges: 0, locationFlags: 2, excessiveTabSwitching: 0 },
    nearbyCount: null,
    evaluationStatus: 'DRAFT',
    totalMarks: null,
    ai: { state: 'NONE', totalMarks: null, percentage: null, needsReview: false },
  });
});

test('marking view: per-question answer, versions, integrity and evaluation', () => {
  const v = toMarkingView(marking, 'EVALUATOR');
  assert.equal(v.evaluationStatus, 'DRAFT');
  assert.deepEqual(v.questions, [
    {
      attemptQuestionId: 'aq-1',
      order: 1,
      type: 'WRITTEN',
      text: 'Explain idempotency.',
      options: [],
      selectedOption: null,
      correctOption: null,
      autoMarks: null,
      maxMarks: 10,
      evaluatorGuidance: 'Mentions retries',
      answer: { text: 'An operation...', wordCount: 2, versions: [{ savedAt: t0.toISOString(), wordCount: 1 }] },
      integrity: { pasteAttempts: 1, bulkInsert: [{ at: t1.toISOString(), grown: 400, typed: 3 }] },
      evaluation: { marks: 7.5, comment: 'Good' },
      ai: null,
      acceptedFromAi: false,
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

// ---- AI fields (docs/ai-evaluation.md §8) ---------------------------------------------

const aiScore = (over: Record<string, unknown> = {}) => ({
  id: 'ai-1',
  status: 'DONE',
  marks: 8,
  maxMarks: 10,
  rationale: 'Covers retries and keys.',
  strengths: ['keys'],
  improvements: ['examples'],
  confidence: 'HIGH',
  concerns: [],
  model: 'gpt-test',
  error: null,
  completedAt: t1,
  // would leak if the mapper spread rows
  runId: 'run-1',
  inputTokens: 100,
  attemptQuestionId: 'aq-1',
  ...over,
});

function withAi(scores: unknown[], evaluation: unknown = { marks: 8, comment: null, aiScoreId: null }) {
  const m = marking as unknown as { questions: Record<string, unknown>[] };
  return { ...marking, questions: [{ ...m.questions[0], aiScores: scores, evaluation }] } as unknown as MarkingSource;
}

test('an Evaluator gets the AI score and reasoning per question, whitelisted', () => {
  const v = toMarkingView(withAi([aiScore({ concerns: ['OFF_TOPIC', 'MADE_UP'] })]), 'EVALUATOR');
  assert.deepEqual(v.questions[0]!.ai, {
    id: 'ai-1',
    status: 'DONE',
    marks: 8,
    maxMarks: 10,
    rationale: 'Covers retries and keys.',
    strengths: ['keys'],
    improvements: ['examples'],
    confidence: 'HIGH',
    concerns: ['OFF_TOPIC'],
    model: 'gpt-test',
    error: null,
    completedAt: t1.toISOString(),
  });
  const keys = keysDeep(v.questions[0]!.ai);
  for (const k of ['runId', 'inputTokens', 'attemptQuestionId', 'aiScoreId']) assert.ok(!keys.has(k), k);
});

test('an Evaluator never receives composite or academics, even with AI present', () => {
  const sub = { ...(withAi([aiScore()]) as unknown as Record<string, unknown>), questions: [{ maxMarksSnapshot: 10, aiScores: [aiScore()] }] } as unknown as SubmissionSource;
  for (const out of [toSubmissionView(sub, 'EVALUATOR'), toMarkingView(withAi([aiScore()]), 'EVALUATOR')]) {
    const keys = keysDeep(out);
    for (const k of ['compositeScore', 'composite', 'compositeProvisional', 'weights', 'xPercentage', 'xiiPercentage', 'majorCpi']) assert.ok(!keys.has(k), k);
  }
});

test('the latest DONE score wins over a newer failed one; with no DONE the latest of any status shows', () => {
  const failed = aiScore({ id: 'ai-2', status: 'FAILED', marks: null, error: 'Grading failed', completedAt: null });
  const done = aiScore({ id: 'ai-1' });
  assert.equal(toMarkingView(withAi([failed, done]), 'EVALUATOR').questions[0]!.ai?.id, 'ai-1');
  const only = toMarkingView(withAi([failed]), 'EVALUATOR').questions[0]!.ai!;
  assert.equal(only.id, 'ai-2');
  assert.equal(only.status, 'FAILED');
  assert.equal(only.marks, null);
  assert.equal(only.error, 'Grading failed');
});

test('acceptedFromAi is true only while the stored mark still carries its AI provenance', () => {
  assert.equal(toMarkingView(withAi([aiScore()], { marks: 8, comment: null, aiScoreId: 'ai-1' }), 'EVALUATOR').questions[0]!.acceptedFromAi, true);
  assert.equal(toMarkingView(withAi([aiScore()], { marks: 8, comment: null, aiScoreId: null }), 'EVALUATOR').questions[0]!.acceptedFromAi, false);
  assert.equal(toMarkingView(withAi([aiScore()], null), 'EVALUATOR').questions[0]!.acceptedFromAi, false);
});

test('submission AI roll-up: NONE, PARTIAL, DONE with totals, and needsReview', () => {
  const rollup = (questions: { maxMarksSnapshot: number; aiScores: unknown[] }[]) =>
    toSubmissionView({ ...submission, questions } as unknown as SubmissionSource, 'EVALUATOR').ai;
  assert.equal(rollup([{ maxMarksSnapshot: 10, aiScores: [] }]).state, 'NONE');
  assert.deepEqual(rollup([{ maxMarksSnapshot: 10, aiScores: [aiScore()] }, { maxMarksSnapshot: 10, aiScores: [] }]), {
    state: 'PARTIAL', totalMarks: null, percentage: null, needsReview: false,
  });
  assert.deepEqual(rollup([{ maxMarksSnapshot: 10, aiScores: [aiScore()] }, { maxMarksSnapshot: 10, aiScores: [aiScore({ marks: 6.5 })] }]), {
    state: 'DONE', totalMarks: 14.5, percentage: 72.5, needsReview: false,
  });
  assert.equal(rollup([{ maxMarksSnapshot: 10, aiScores: [aiScore({ confidence: 'LOW' })] }]).needsReview, true);
  assert.equal(rollup([{ maxMarksSnapshot: 10, aiScores: [aiScore({ concerns: ['TOO_SHORT'] })] }]).needsReview, true);
  assert.equal(rollup([{ maxMarksSnapshot: 10, aiScores: [aiScore({ status: 'FAILED', marks: null })] }]).state, 'PARTIAL');
});

test('evaluator DTO has round and type, no college; Super Admin also gets the drive name', () => {
  for (const out of [toSubmissionView(submission, 'EVALUATOR'), toMarkingView(marking, 'EVALUATOR')]) {
    assert.equal(out.roundNumber, 2);
    assert.equal(out.jobProfileType, 'INTERNSHIP');
    const text = JSON.stringify(out);
    assert.ok(!/IITG|Nov 2026|driveDisplayName|college/i.test(text), text);
  }
  assert.equal(toSubmissionView(submission, 'SUPER_ADMIN').driveDisplayName, 'Backend Engineer · Round 2 · IITG · Nov 2026');
});

test('marking view shows MCQ choice, correct and auto mark read-only', () => {
  const src = {
    ...marking,
    mcqMarks: 1.75,
    mcqMaxMarks: 3,
    questions: [
      {
        ...(marking.questions[0] as object),
        id: 'aq-m',
        order: 1,
        typeSnapshot: 'MCQ',
        textSnapshot: 'Which is prime?',
        maxMarksSnapshot: 2,
        optionsSnapshot: ['9', '7', '4', '6'],
        correctSnapshot: 1,
        autoMarks: 2,
        answer: { text: '', wordCount: 0, selectedOption: 1, versions: [] },
        evaluation: null,
      },
      { ...(marking.questions[0] as object), id: 'aq-w', order: 2, typeSnapshot: 'WRITTEN' },
    ],
  } as unknown as MarkingSource;
  const v = toMarkingView(src, 'EVALUATOR');
  assert.equal(v.mcqMarks, 1.75);
  assert.equal(v.mcqMaxMarks, 3);
  const [m, w] = v.questions;
  assert.equal(m!.type, 'MCQ');
  assert.deepEqual(m!.options, ['9', '7', '4', '6']);
  assert.equal(m!.selectedOption, 1);
  assert.equal(m!.correctOption, 1);
  assert.equal(m!.autoMarks, 2);
  assert.equal(w!.type, 'WRITTEN');
  assert.deepEqual(w!.options, []);
  assert.equal(w!.selectedOption, null);
  assert.equal(w!.correctOption, null);
  assert.equal(w!.autoMarks, null);
  // The AI roll-up looks at written questions only: an MCQ never has an AI score.
  assert.equal(v.ai.state, 'NONE');
});

test('AI roll-up is DONE when every written question is scored, ignoring MCQs', () => {
  const done = { id: 'ai-1', status: 'DONE', marks: 4, maxMarks: 5, rationale: null, strengths: [], improvements: [], confidence: 'HIGH', concerns: [], model: 'm', error: null, completedAt: t1 };
  const sub = {
    ...submission,
    questions: [
      { typeSnapshot: 'MCQ', maxMarksSnapshot: 2, aiScores: [] },
      { typeSnapshot: 'WRITTEN', maxMarksSnapshot: 5, aiScores: [done] },
    ],
  } as unknown as SubmissionSource;
  const ai = toSubmissionView(sub, 'EVALUATOR').ai;
  assert.equal(ai.state, 'DONE');
  assert.equal(ai.totalMarks, 4);
  assert.equal(ai.percentage, 80);
});
