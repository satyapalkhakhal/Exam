// Evaluation, decisions, leaderboard, dashboard and exports end to end against
// exam_test: the soft lock between two evaluators, draft and submit rules,
// blind payloads, Super-Admin-only decisions/reopen/leaderboard/exports, and
// the tie-break by submit time. Other suites may run at the same time, so this
// file only creates uniquely named rows and never truncates or flushes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import { closeAutoSubmitQueue } from '../../src/infrastructure/queue/autoSubmit.queue.js';

const RUN = crypto.randomBytes(4).toString('hex');
const PASS = 'eval-int-pass-123';
const admins = {
  sa: { email: `sa-${RUN}@eval.int.test`, name: `Eval SA ${RUN}`, role: 'SUPER_ADMIN' },
  a: { email: `ea-${RUN}@eval.int.test`, name: `Evaluator Asha ${RUN}`, role: 'EVALUATOR' },
  b: { email: `eb-${RUN}@eval.int.test`, name: `Evaluator Bala ${RUN}`, role: 'EVALUATOR' },
} as const;
type Who = keyof typeof admins;

let app: Express;
const agents = {} as Record<Who, request.Agent>;
const adminIds = {} as Record<Who, string>;
let roleId = '';
let roundId = '';
let examId = '';
let board!: ExamSeed;
let questionIds: string[] = [];
let attemptId = '';
let candidateId = '';
let entryId = '';
let aqIds: string[] = [];
const boardRows: Record<string, Submitted> = {};

const mobile = () => `9${crypto.randomInt(100_000_000, 999_999_999)}`;
const HERE = { stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.144, longitude: 91.736, accuracyM: 25 } as const;

interface Q {
  id: string;
  text: string;
  max: number;
}
interface ExamSeed {
  roleId: string;
  examId: string;
  examName: string;
  roundIds: string[];
  /** One question per round, unless the caller adds its own. */
  qs: Q[][];
}
interface Submitted {
  candidateId: string;
  attemptId: string;
  entryId: string;
  aqIds: string[];
}

async function signIn(who: Who) {
  const stale = await getRedis().keys('exam:rl:*');
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send({ email: admins[who].email, password: PASS });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent.post('/api/admin/auth/verify-otp').send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

/** A job profile with one exam of `rounds` open rounds, each with one 10-mark question (unless `withQuestions` is false). */
async function makeExam(label: string, rounds = 1, opts: { refApplicantCount?: number; active?: boolean; withQuestions?: boolean } = {}): Promise<ExamSeed> {
  const role = await prisma.jobRole.create({ data: { name: `${label} Profile ${RUN}`, refApplicantCount: opts.refApplicantCount ?? 0 } });
  const exam = await prisma.exam.create({ data: { jobRoleId: role.id, name: `${label} ${RUN}`, active: opts.active ?? true } });
  const seed: ExamSeed = { roleId: role.id, examId: exam.id, examName: exam.name, roundIds: [], qs: [] };
  for (let n = 1; n <= rounds; n++) {
    const r = await prisma.examRound.create({ data: { examId: exam.id, roundNumber: n, isOpen: true, durationMinutes: 60 } });
    seed.roundIds.push(r.id);
    if (opts.withQuestions === false) {
      seed.qs.push([]);
      continue;
    }
    const q = await prisma.question.create({
      data: { roundId: r.id, text: `${label} R${n} question`, normalizedTextHash: `${label}-${n}-${RUN}`, maxMarks: 10, displayOrder: 1 },
    });
    seed.qs.push([{ id: q.id, text: q.text, max: 10 }]);
  }
  return seed;
}

async function makePerson(key: string, fullName = `Cand ${key} ${RUN}`) {
  return prisma.candidate.create({
    data: {
      candidateCode: `EV-${RUN}-${key}`,
      fullName,
      email: `${key}-${RUN}@eval.int.test`,
      mobile: mobile(),
      rollNumber: `R-${RUN}-${key}`,
      majorCpi: 8.5,
    },
  });
}

/** The person's entry in the round (registering for the round's exam when needed). */
async function enter(personId: string, forRoundId: string, status: 'NOT_STARTED' | 'SUBMITTED' | 'EVALUATED' | 'SHORTLISTED' | 'REJECTED' | 'IN_PROGRESS' = 'NOT_STARTED') {
  const r = await prisma.examRound.findUniqueOrThrow({ where: { id: forRoundId }, select: { examId: true } });
  const reg = await prisma.examRegistration.upsert({
    where: { candidateId_examId: { candidateId: personId, examId: r.examId } },
    create: { candidateId: personId, examId: r.examId },
    update: {},
  });
  return (await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: forRoundId, status } })).id;
}

/** A submitted attempt over the round's questions; a new person unless `personId` is given. */
async function submittedCandidate(key: string, forRoundId: string, qs: Q[], submittedAt: Date, fullName?: string, personId?: string): Promise<Submitted> {
  const id = personId ?? (await makePerson(key, fullName)).id;
  const entry = await enter(id, forRoundId, 'SUBMITTED');
  const a = await prisma.examAttempt.create({
    data: {
      candidateId: id,
      roundEntryId: entry,
      status: 'SUBMITTED',
      startedAt: new Date(submittedAt.getTime() - 40 * 60_000),
      endsAt: new Date(submittedAt.getTime() + 20 * 60_000),
      submittedAt,
      submitType: 'MANUAL',
      activeSessionId: crypto.randomUUID(),
      startIp: '198.51.100.20',
      userAgent: 'int-test',
      maxMarks: qs.reduce((t, q) => t + q.max, 0),
      questions: {
        create: qs.map((q, i) => ({
          questionId: q.id,
          order: i + 1,
          textSnapshot: q.text,
          maxMarksSnapshot: q.max,
          answer: { create: { text: `Answer ${i + 1} by ${key}`, wordCount: 4 } },
        })),
      },
    },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return { candidateId: id, attemptId: a.id, entryId: entry, aqIds: a.questions.map((q) => q.id) };
}

/** Marks a one-question submission as evaluated with `total`, as the marking flow would leave it. */
async function evaluate(s: Submitted, total: number) {
  await prisma.questionEvaluation.create({ data: { attemptQuestionId: s.aqIds[0]!, marks: total, evaluatorId: adminIds.sa } });
  await prisma.attemptEvaluation.create({ data: { attemptId: s.attemptId, status: 'SUBMITTED', evaluatorId: adminIds.sa, submittedAt: new Date() } });
  await prisma.examAttempt.update({ where: { id: s.attemptId }, data: { totalMarks: total, percentage: total * 10 } });
  await prisma.roundEntry.update({ where: { id: s.entryId }, data: { status: 'EVALUATED' } });
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  const hash = await bcrypt.hash(PASS, 4);
  for (const who of Object.keys(admins) as Who[]) {
    const a = admins[who];
    adminIds[who] = (await prisma.adminUser.create({ data: { email: a.email, name: a.name, role: a.role, passwordHash: hash } })).id;
  }
  const main = await makeExam('Eval Role', 1, { refApplicantCount: 40, withQuestions: false });
  roleId = main.roleId;
  examId = main.examId;
  roundId = main.roundIds[0]!;
  const q1 = await prisma.question.create({
    data: { roundId, text: 'Explain idempotency.', normalizedTextHash: `e1-${RUN}`, maxMarks: 10, evaluatorGuidance: 'Mentions retries', displayOrder: 1 },
  });
  const q2 = await prisma.question.create({
    data: { roundId, text: 'Explain backpressure.', normalizedTextHash: `e2-${RUN}`, maxMarks: 5, displayOrder: 2 },
  });
  questionIds = [q1.id, q2.id];
  const qs = [
    { id: q1.id, text: q1.text, max: 10 },
    { id: q2.id, text: q2.text, max: 5 },
  ];
  const m = await submittedCandidate('m', roundId, qs, new Date(Date.now() - 3_600_000), `=HYPERLINK("http://x") ${RUN}`);
  ({ attemptId, candidateId, aqIds, entryId } = m);
  await prisma.activityLog.createMany({
    data: [
      { candidateId, attemptId, eventType: 'PASTE_ATTEMPT', questionId: aqIds[0]!, ip: '198.51.100.20' },
      { candidateId, attemptId, eventType: 'SUSPICIOUS_BULK_INSERT', questionId: aqIds[0]!, ip: '198.51.100.20', metadata: { grown: 300, typed: 2, rate: 0 } },
    ],
  });
  await prisma.candidateLoginLog.create({
    data: { candidateId, stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.1, longitude: 91.7, ip: '198.51.100.20', userAgent: 'x', browser: 'x', os: 'x', deviceType: 'desktop' },
  });
  await enter((await makePerson('ns', 'Not Started')).id, roundId);

  // Leaderboard exam: in round 1 tied totals are separated by submit time;
  // "top" also sits round 2, where a round-2-only person beats them.
  board = await makeExam('Eval Board', 2);
  const [r1, r2] = board.roundIds as [string, string];
  const base = Date.now() - 10 * 3_600_000;
  for (const [key, total, offsetMin] of [['late', 8, 30], ['early', 8, 10], ['top', 9, 60]] as const) {
    const s = await submittedCandidate(key, r1, board.qs[0]!, new Date(base + offsetMin * 60_000));
    await evaluate(s, total);
    boardRows[key] = s;
  }
  await submittedCandidate('pending', r1, board.qs[0]!, new Date(base));
  boardRows.top2 = await submittedCandidate('top-r2', r2, board.qs[1]!, new Date(base + 120 * 60_000), undefined, boardRows.top!.candidateId);
  await evaluate(boardRows.top2, 4);
  boardRows.r2only = await submittedCandidate('r2only', r2, board.qs[1]!, new Date(base + 90 * 60_000));
  await evaluate(boardRows.r2only, 7);

  app = createApp();
  for (const who of Object.keys(admins) as Who[]) agents[who] = await signIn(who);
});

after(async () => {
  await closeAutoSubmitQueue();
  await prisma.$disconnect();
  await getRedis().quit();
});

const PII = ['fullName', 'email', 'mobile', 'rollNumber', 'majorCpi', 'xPercentage', 'xiiPercentage', 'programme', 'discipline', 'latitude', 'longitude', 'ip', 'candidateId'];
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
}

const save = (who: Who, items: { attemptQuestionId: string; marks: number | null; comment?: string | null }[], submit: boolean) =>
  agents[who].put(`/api/admin/submissions/${attemptId}/evaluation`).send({ items, submit });

test('submissions list: evaluator rows are blind and cannot be searched by name; SA rows carry PII', async () => {
  const ev = await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}`);
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.equal(ev.body.data.total, 1);
  assert.equal(ev.body.data.page, 1);
  const row = ev.body.data.items[0];
  assert.equal(row.attemptId, attemptId);
  assert.equal(row.evaluationStatus, 'PENDING');
  assert.equal(row.timeTakenSec, 2400);
  assert.deepEqual(PII.filter((k) => keysDeep(ev.body).has(k)), []);
  assert.equal(row.flagCounts.pasteAttempts, 1);
  assert.equal(row.flagCounts.bulkInsert, 1);
  assert.equal(row.jobRole, `Eval Role Profile ${RUN}`);
  assert.equal(row.examName, `Eval Role ${RUN}`);
  assert.equal(row.roundNumber, 1);

  const byName = await agents.a.get(`/api/admin/submissions?search=${encodeURIComponent(`HYPERLINK("http://x") ${RUN}`)}`);
  assert.equal(byName.body.data.total, 0);
  const byCode = await agents.a.get(`/api/admin/submissions?search=EV-${RUN}-m`);
  assert.equal(byCode.body.data.total, 1);

  const sa = await agents.sa.get(`/api/admin/submissions?search=${encodeURIComponent(`HYPERLINK("http://x") ${RUN}`)}`);
  assert.equal(sa.body.data.total, 1);
  assert.equal(sa.body.data.items[0].candidateId, candidateId);
  assert.ok(sa.body.data.items[0].fullName.includes('HYPERLINK'));
  assert.equal(sa.body.data.items[0].latitude, undefined);
});

test('submissions filter by exam and round; one row per attempt with that round\'s number', async () => {
  const byExam = await agents.a.get(`/api/admin/submissions?examId=${board.examId}&pageSize=100`);
  assert.equal(byExam.status, 200, JSON.stringify(byExam.body));
  assert.equal(byExam.body.data.total, 6);
  const r2 = await agents.a.get(`/api/admin/submissions?roundId=${board.roundIds[1]}`);
  assert.equal(r2.body.data.total, 2);
  assert.deepEqual(
    (r2.body.data.items as { attemptId: string; roundNumber: number; examName: string }[]).map((i) => [i.attemptId, i.roundNumber, i.examName]).sort(),
    [boardRows.top2!.attemptId, boardRows.r2only!.attemptId].map((id) => [id, 2, board.examName]).sort(),
  );
  // the main exam's attempt carries its own flags, not those of another attempt
  const main = await agents.a.get(`/api/admin/submissions?examId=${examId}`);
  assert.equal(main.body.data.total, 1);
  const r1 = await agents.a.get(`/api/admin/submissions?roundId=${board.roundIds[0]}`);
  assert.ok((r1.body.data.items as { flagCounts: { pasteAttempts: number } }[]).every((i) => i.flagCounts.pasteAttempts === 0));
});

test('evaluator A locks; evaluator B is refused with 423 naming A, but can still read the marking view', async () => {
  const lock = await agents.a.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(lock.status, 200, JSON.stringify(lock.body));
  assert.deepEqual(lock.body.data.lockedBy, { id: adminIds.a, name: admins.a.name });
  assert.ok(lock.body.data.lockedAt);

  const again = await agents.a.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(again.status, 200);

  const other = await agents.b.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(other.status, 423);
  assert.equal(other.body.error.code, 'EVALUATION_LOCKED');
  assert.deepEqual(other.body.error.details.lockedBy, { id: adminIds.a, name: admins.a.name });
  assert.ok(other.body.error.message.includes(admins.a.name));

  const view = await agents.b.get(`/api/admin/submissions/${attemptId}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual(PII.filter((k) => keysDeep(view.body).has(k)), []);
  assert.equal(view.body.data.questions.length, 2);
  const q1 = view.body.data.questions[0];
  assert.equal(q1.evaluatorGuidance, 'Mentions retries');
  assert.equal(q1.answer.text, 'Answer 1 by m');
  assert.equal(q1.integrity.pasteAttempts, 1);
  assert.deepEqual(q1.integrity.bulkInsert.map((b: { grown: number; typed: number }) => [b.grown, b.typed]), [[300, 2]]);

  const blocked = await agents.b.put(`/api/admin/submissions/${attemptId}/evaluation`).send({ items: [], submit: false });
  assert.equal(blocked.status, 423);
  assert.deepEqual(blocked.body.error.details.lockedBy, { id: adminIds.a, name: admins.a.name });

  const notMine = await agents.b.delete(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(notMine.status, 204);
  assert.equal((await agents.b.post(`/api/admin/submissions/${attemptId}/lock`)).status, 423);
});

test('a draft accepts null marks; out-of-range marks are MARKS_OUT_OF_RANGE with the question id', async () => {
  const draft = await save('a', [
    { attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' },
    { attemptQuestionId: aqIds[1]!, marks: null, comment: '' },
  ], false);
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const list = await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}&evaluation=DRAFT`);
  assert.equal(list.body.data.total, 1);
  assert.equal((await agents.a.get(`/api/admin/submissions?jobRoleId=${roleId}&evaluation=PENDING`)).body.data.total, 0);

  const bad = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 5.5 }], false);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'MARKS_OUT_OF_RANGE');
  assert.equal(bad.body.error.details.attemptQuestionId, aqIds[1]);

  const foreign = await save('a', [{ attemptQuestionId: board.top!.aqIds[0]!, marks: 1 }], false);
  assert.equal(foreign.status, 400);
});

const entryStatus = async (id: string) => (await prisma.roundEntry.findUniqueOrThrow({ where: { id } })).status;
const markRow = (aq: string) => prisma.questionEvaluation.findUnique({ where: { attemptQuestionId: aq } });

test('a draft comment without marks persists; an omitted comment is kept; an empty one clears', async () => {
  const r1 = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null, comment: 'Needs work' }], false);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  let view = await agents.a.get(`/api/admin/submissions/${attemptId}`);
  assert.deepEqual(view.body.data.questions[1].evaluation, { marks: null, comment: 'Needs work' });

  // marks change, comment omitted: the stored comment stays
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 6 }], false)).status, 200);
  assert.equal((await markRow(aqIds[0]!))?.comment, 'Good');
  // marks null, comment omitted: comment-only row stays
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null }], false)).status, 200);
  view = await agents.a.get(`/api/admin/submissions/${attemptId}`);
  assert.deepEqual(view.body.data.questions[1].evaluation, { marks: null, comment: 'Needs work' });
  // explicit null clears a comment; with no marks the row goes away
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5, comment: null }], false)).status, 200);
  assert.equal((await markRow(aqIds[0]!))?.comment, null);
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' }], false)).status, 200);
});

test('submit with a missing question is 400', async () => {
  // aqIds[1] has a comment-only row: that still counts as unmarked
  const res = await save('a', [{ attemptQuestionId: aqIds[0]!, marks: 7.5 }], true);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body.error.details.missing, [aqIds[1]]);
  assert.equal((await save('a', [{ attemptQuestionId: aqIds[1]!, marks: null, comment: '' }], false)).status, 200);
  assert.equal(await markRow(aqIds[1]!), null);
  assert.equal(await entryStatus(entryId), 'SUBMITTED');
});

test('submit complete: totals computed, round entry EVALUATED with history, audited, lock released', async () => {
  const res = await save('a', [
    { attemptQuestionId: aqIds[0]!, marks: 7.5, comment: 'Good' },
    { attemptQuestionId: aqIds[1]!, marks: 2 },
  ], true);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { evaluationStatus: 'SUBMITTED', totalMarks: 9.5, maxMarks: 15, percentage: 63.33 });

  assert.equal(await entryStatus(entryId), 'EVALUATED');
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId, toStatus: 'EVALUATED' } });
  assert.equal(h.roundEntryId, entryId);
  assert.equal(h.fromStatus, 'SUBMITTED');
  assert.equal(h.byAdminId, adminIds.a);
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  assert.equal(a.totalMarks?.toNumber(), 9.5);
  assert.equal(a.percentage?.toNumber(), 63.33);
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'EVALUATION_SUBMITTED', entityId: attemptId, adminId: adminIds.a } }), 1);

  const again = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 3 }], false);
  assert.equal(again.status, 409);
  // the lock was released on submit, and a submitted evaluation cannot be locked again; it stays readable
  const relock = await agents.b.post(`/api/admin/submissions/${attemptId}/lock`);
  assert.equal(relock.status, 409);
  assert.equal(relock.body.error.code, 'CONFLICT');
  assert.equal((await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId } })).lockedById, null);
  assert.equal((await agents.b.get(`/api/admin/submissions/${attemptId}`)).status, 200);
});

test('an Evaluator calling decision, reopen, leaderboard or exports is 403', async () => {
  const d = await agents.a.post(`/api/admin/entries/${entryId}/decision`).send({ decision: 'SHORTLISTED' });
  assert.equal(d.status, 403);
  assert.equal((await agents.a.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'x' })).status, 403);
  assert.equal((await agents.a.get(`/api/admin/leaderboard?roundId=${roundId}`)).status, 403);
  assert.equal((await agents.a.get('/api/admin/exports/results.xlsx')).status, 403);
  assert.equal((await agents.a.get('/api/admin/exports/activity.xlsx')).status, 403);
  assert.equal(await entryStatus(entryId), 'EVALUATED');
});

test('SA decision on an entry: shortlist from EVALUATED with history; refused from a non-evaluated status', async () => {
  assert.equal((await agents.sa.post(`/api/admin/candidates/${candidateId}/decision`).send({ decision: 'SHORTLISTED' })).status, 404);
  const d = await agents.sa.post(`/api/admin/entries/${entryId}/decision`).send({ decision: 'SHORTLISTED', comment: 'Strong' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.deepEqual(d.body.data, { entryId, status: 'SHORTLISTED' });
  assert.equal(await entryStatus(entryId), 'SHORTLISTED');
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { roundEntryId: entryId, toStatus: 'SHORTLISTED' } });
  assert.equal(h.candidateId, candidateId);
  assert.equal(h.fromStatus, 'EVALUATED');
  assert.equal(h.comment, 'Strong');
  const audit = await prisma.adminAuditLog.findMany({ where: { action: 'CANDIDATE_DECISION', entityId: candidateId } });
  assert.equal(audit.length, 1);
  assert.equal((audit[0]!.metadata as { roundEntryId: string }).roundEntryId, entryId);
  // a one-round exam: shortlisting the last round just records the decision
  assert.equal(await prisma.roundEntry.count({ where: { registration: { candidateId } } }), 1);

  const again = await agents.sa.post(`/api/admin/entries/${entryId}/decision`).send({ decision: 'SHORTLISTED' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.message, 'The candidate is already shortlisted');

  const pending = await prisma.roundEntry.findFirstOrThrow({ where: { registration: { candidate: { candidateCode: `EV-${RUN}-pending` } } } });
  const refused = await agents.sa.post(`/api/admin/entries/${pending.id}/decision`).send({ decision: 'REJECTED' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.message, 'A decision can only be made after the evaluation is submitted');
  assert.equal((await agents.sa.post(`/api/admin/entries/${crypto.randomUUID()}/decision`).send({ decision: 'REJECTED' })).status, 404);
});

test('leaderboard: evaluated only, by total desc then submittedAt asc, with rank, PII and per-question marks', async () => {
  const res = await agents.sa.get(`/api/admin/leaderboard?roundId=${board.roundIds[0]}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = res.body.data.items as { rank: number; candidateId: string; entryId: string; status: string; fullName: string; totalMarks: number; percentage: number; questionMarks: unknown[] }[];
  assert.deepEqual(items.map((i) => i.candidateId), [boardRows.top!.candidateId, boardRows.early!.candidateId, boardRows.late!.candidateId]);
  assert.deepEqual(items.map((i) => i.entryId), [boardRows.top!.entryId, boardRows.early!.entryId, boardRows.late!.entryId]);
  assert.deepEqual(items.map((i) => i.status), ['EVALUATED', 'EVALUATED', 'EVALUATED']);
  assert.deepEqual(items.map((i) => i.rank), [1, 2, 3]);
  assert.equal(items[0]!.totalMarks, 9);
  assert.ok(items[0]!.fullName);
  assert.deepEqual(items[0]!.questionMarks, [{ order: 1, marks: 9, maxMarks: 10 }]);
});

test('leaderboard is per round', async () => {
  const res = await agents.sa.get(`/api/admin/leaderboard?roundId=${board.roundIds[1]}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = res.body.data.items as { rank: number; candidateId: string; entryId: string; totalMarks: number }[];
  // "top" leads round 1 with 9 but trails round 2 with 4; round-1-only people are absent
  assert.deepEqual(
    items.map((i) => [i.rank, i.entryId, i.totalMarks]),
    [
      [1, boardRows.r2only!.entryId, 7],
      [2, boardRows.top2!.entryId, 4],
    ],
  );
  assert.equal(items[1]!.candidateId, boardRows.top!.candidateId);
  const none = await agents.sa.get(`/api/admin/leaderboard?roundId=${crypto.randomUUID()}`);
  assert.deepEqual(none.body.data.items, []);
  assert.equal((await agents.sa.get(`/api/admin/leaderboard?jobRoleId=${board.roleId}`)).status, 400);
});

test('SA reopen: evaluation back to DRAFT, round entry back to the submitted status, logged', async () => {
  const res = await agents.sa.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'Recheck Q2' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId } })).status, 'DRAFT');
  assert.equal(await entryStatus(entryId), 'SUBMITTED');
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { roundEntryId: entryId, toStatus: 'SUBMITTED', comment: 'Recheck Q2' } });
  assert.equal(h.fromStatus, 'SHORTLISTED');
  assert.equal(h.comment, 'Recheck Q2');
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'EVALUATION_REOPENED', entityId: attemptId } }), 1);
  const view = await agents.sa.get(`/api/admin/submissions/${attemptId}`);
  assert.equal(view.body.data.evaluationStatus, 'DRAFT');
  assert.equal(view.body.data.questions[1].evaluation.marks, 2);
  assert.equal((await agents.sa.post(`/api/admin/submissions/${attemptId}/reopen`).send({ reason: 'again' })).status, 409);

  // nobody holds the lock now: a save without taking it is 423 with lockedBy null
  const unlocked = await save('a', [{ attemptQuestionId: aqIds[1]!, marks: 3 }], false);
  assert.equal(unlocked.status, 423);
  assert.equal(unlocked.body.error.details.lockedBy, null);
});

test('dashboard: per-round counts for any admin', async () => {
  for (const who of ['sa', 'a'] as const) {
    const res = await agents[who].get('/api/admin/dashboard');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rounds = res.body.data.rounds as { roundId: string; evaluated: number; pendingEvaluation: number }[];
    assert.deepEqual(
      rounds.find((r) => r.roundId === roundId),
      {
        examId,
        examName: `Eval Role ${RUN}`,
        jobRoleName: `Eval Role Profile ${RUN}`,
        roundId,
        roundNumber: 1,
        entered: 2,
        notStarted: 1,
        inProgress: 0,
        submitted: 1,
        autoSubmitted: 0,
        pendingEvaluation: 1,
        evaluated: 0,
        shortlisted: 0,
        rejected: 0,
      },
    );
    const b = rounds.find((r) => r.roundId === board.roundIds[0])!;
    assert.equal(b.evaluated, 3);
    assert.equal(b.pendingEvaluation, 1);
  }
});

test('dashboard counts per round', async () => {
  const d = await makeExam('Eval Dash', 2, { withQuestions: false });
  const [r1, r2] = d.roundIds as [string, string];
  const people = await Promise.all(['d1', 'd2', 'd3', 'd4'].map((k) => makePerson(k)));
  await enter(people[0]!.id, r1, 'SHORTLISTED');
  await enter(people[0]!.id, r2, 'IN_PROGRESS');
  await enter(people[1]!.id, r1, 'SHORTLISTED');
  await enter(people[1]!.id, r2, 'NOT_STARTED');
  await enter(people[2]!.id, r1, 'REJECTED');
  await enter(people[3]!.id, r1, 'EVALUATED');
  const off = await makeExam('Eval Dash Off', 1, { active: false, withQuestions: false });
  await enter(people[3]!.id, off.roundIds[0]!, 'NOT_STARTED');

  const res = await agents.a.get('/api/admin/dashboard');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rounds = res.body.data.rounds as { examId: string; roundId: string; roundNumber: number; entered: number; shortlisted: number; rejected: number; evaluated: number; inProgress: number; notStarted: number }[];
  const mine = rounds.filter((r) => r.examId === d.examId);
  assert.deepEqual(
    mine.map((r) => [r.roundNumber, r.entered, r.notStarted, r.inProgress, r.evaluated, r.shortlisted, r.rejected]),
    [
      [1, 4, 0, 0, 1, 2, 1],
      [2, 2, 1, 1, 0, 0, 0],
    ],
  );
  assert.equal(rounds.filter((r) => r.examId === off.examId).length, 0, 'inactive exams are not on the dashboard');
});

async function workbook(res: request.Response) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.body as Buffer);
  return wb;
}
const binary = (r: request.Request) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

test('results.xlsx: one sheet per role, escaped strings, per-question marks', async () => {
  const res = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${boardRoleId}`));
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /spreadsheetml/);
  assert.match(String(res.headers['content-disposition']), new RegExp(`^attachment; filename="results-eval-board-${RUN}-\\d{4}-\\d{2}-\\d{2}\\.xlsx"$`));
  const wb = await workbook(res);
  assert.equal(wb.worksheets.length, 1);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  assert.ok(header.includes('Q1 marks'));
  assert.ok(header.includes('Total'));
  assert.equal(ws.getRow(2).getCell(header.indexOf('Candidate code') + 1).value, `EV-${RUN}-top`);

  const all = await binary(agents.sa.get(`/api/admin/exports/results.xlsx?jobRoleId=${roleId}`));
  const ws2 = (await workbook(all)).worksheets[0]!;
  const h2 = (ws2.getRow(1).values as unknown[]).slice(1);
  const names = [2, 3].map((r) => ws2.getRow(r).getCell(h2.indexOf('Name') + 1).value);
  assert.ok(names.includes(`'=HYPERLINK("http://x") ${RUN}`), JSON.stringify(names));
  // the reopened (DRAFT) attempt shows no marks, totals or comments
  const mRow = [2, 3].map((r) => ws2.getRow(r)).find((row) => row.getCell(h2.indexOf('Candidate code') + 1).value === `EV-${RUN}-m`)!;
  for (const col of ['Q1 marks', 'Q2 marks', 'Total', 'Max', 'Percentage', 'Evaluator comments']) {
    assert.equal(mRow.getCell(h2.indexOf(col) + 1).value, null, col);
  }
  const top = ws.getRow(2);
  assert.equal(top.getCell(header.indexOf('Q1 marks') + 1).value, 9);
  assert.equal(top.getCell(header.indexOf('Max') + 1).value, 10);
});

test('activity.xlsx: integrity and location flags per candidate', async () => {
  const res = await binary(agents.sa.get(`/api/admin/exports/activity.xlsx?jobRoleId=${roleId}`));
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-disposition']), /^attachment; filename="activity-eval-role-/);
  const ws = (await workbook(res)).worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1);
  const row = ws.getRow(2);
  assert.equal(row.getCell(header.indexOf('Paste/copy attempts') + 1).value, 1);
  assert.equal(row.getCell(header.indexOf('Bulk inserts') + 1).value, 1);
  assert.ok(!header.some((h) => /latitude|longitude/i.test(String(h))));
});

test('marking view for an unknown or not-submitted attempt is 404', async () => {
  assert.equal((await agents.a.get(`/api/admin/submissions/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await agents.a.post(`/api/admin/submissions/${crypto.randomUUID()}/lock`)).status, 404);
  assert.ok(questionIds.length === 2);
});

// ---- final review fixes ---------------------------------------------------

async function freshSubmission(key: string) {
  const role = await prisma.jobRole.create({ data: { name: `Eval ${key} ${RUN}`, examSetting: { create: {} } } });
  const q = await prisma.question.create({ data: { jobRoleId: role.id, text: `Q ${key}`, normalizedTextHash: `${key}-${RUN}`, maxMarks: 10 } });
  return submittedCandidate(key, role.id, [{ id: q.id, text: q.text, max: 10 }], new Date(Date.now() - 60_000));
}

test('I9: the holder re-POSTing the lock extends it, so a long session keeps it', async () => {
  const s = await freshSubmission('renew');
  assert.equal((await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  // 25 of the 30 minutes have passed without a draft save.
  const old = new Date(Date.now() - 25 * 60_000);
  await prisma.attemptEvaluation.update({ where: { attemptId: s.attemptId }, data: { lockedAt: old } });
  const renewed = await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const row = await prisma.attemptEvaluation.findUniqueOrThrow({ where: { attemptId: s.attemptId } });
  assert.equal(row.lockedById, adminIds.a);
  assert.ok(row.lockedAt && Date.now() - row.lockedAt.getTime() < 60_000, 'lockedAt moved to now');
  assert.equal((await agents.b.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 423);
  await agents.a.delete(`/api/admin/submissions/${s.attemptId}/lock`);
});

test('T11#2: a reopen racing a decision records the decided status as "from", not a stale read', async () => {
  const s = await freshSubmission('race');
  assert.equal((await agents.sa.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  const sub = await agents.sa.put(`/api/admin/submissions/${s.attemptId}/evaluation`).send({ items: [{ attemptQuestionId: s.aqIds[0]!, marks: 6 }], submit: true });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  // A decision holds the candidate row while the reopen arrives.
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const decision = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${s.candidateId}::uuid FOR UPDATE`;
    await tx.candidate.update({ where: { id: s.candidateId }, data: { status: 'SHORTLISTED' } });
    await tx.candidateStatusHistory.create({ data: { candidateId: s.candidateId, fromStatus: 'EVALUATED', toStatus: 'SHORTLISTED', byAdminId: adminIds.sa } });
    locked();
    await new Promise((r) => setTimeout(r, 500));
  });
  await isLocked;
  const reopen = agents.sa.post(`/api/admin/submissions/${s.attemptId}/reopen`).send({ reason: 'race' });
  const [res] = await Promise.all([reopen, decision]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const h = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId: s.candidateId, comment: 'race' } });
  assert.equal(h.fromStatus, 'SHORTLISTED');
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'EVALUATION_REOPENED', entityId: s.attemptId } });
  assert.equal((audit.metadata as { fromStatus: string }).fromStatus, 'SHORTLISTED');
});

test('T11#2: submitting marks for an attempt that was reset meanwhile is refused and leaves the candidate alone', async () => {
  const s = await freshSubmission('resetrace');
  assert.equal((await agents.a.post(`/api/admin/submissions/${s.attemptId}/lock`)).status, 200);
  const reset = await agents.sa.post(`/api/admin/candidates/${s.candidateId}/reset-attempt`).send({ reason: 'tech issue' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const sub = await agents.a.put(`/api/admin/submissions/${s.attemptId}/evaluation`).send({ items: [{ attemptQuestionId: s.aqIds[0]!, marks: 6 }], submit: true });
  assert.notEqual(sub.status, 200);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: s.candidateId } })).status, 'NOT_STARTED');
});
