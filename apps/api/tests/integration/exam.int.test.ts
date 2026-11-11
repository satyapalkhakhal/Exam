// The exam engine end to end against exam_test and Redis db 15: start (with the
// location gate and the role lock), the state read, autosave ordering, single
// session, the grace deadline, beacons on an expired access cookie, activity
// events, submit, the auto-submit sweep and the review flags. Other suites may
// run at the same time, so this file only creates uniquely named rows and never
// truncates tables or flushes Redis.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';
import { autoSubmitAttempt, getFlagCounts, exam } from '../../src/modules/exam/index.js';
import { sweepExpiredAttempts } from '../../src/infrastructure/queue/sweep.js';
import { closeAutoSubmitQueue, getAutoSubmitQueue } from '../../src/infrastructure/queue/autoSubmit.queue.js';
import { createApplication, createCandidate, createCandidates, createDrive } from './helpers.js';
import { issueRefreshToken, peekRefreshFamily, signAccess } from '../../src/modules/adminAuth/tokens.js';

const RUN = crypto.randomBytes(4).toString('hex');
const GUIDE = `SECRET-GUIDE-${RUN}`;
const HERE = { stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.144, longitude: 91.736, accuracyM: 25 } as const;

let app: Express;
let roleId = '';
let closedRoleId = '';
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
/** jobRoleId -> its Round 1 and the test drive (spec 2026-11-10: settings live on round + drive). */
const driveOf: Record<string, { roundId: string; driveId: string }> = {};

const mobile = () => `9${crypto.randomInt(100_000_000, 999_999_999)}`;

async function makeCandidate(key: string, jobRoleId: string, extra: { locationExempt?: boolean } = {}) {
  const email = `${key}-${RUN}@exam.int.test`;
  const c = await createCandidate({ candidateCode: `X-${RUN}-${key}`, fullName: `Exam ${key}`, email, mobile: mobile(), jobRoleId, driveId: driveOf[jobRoleId]!.driveId, ...extra });
  emails[key] = email;
  ids[key] = c.id;
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  const role = await prisma.jobRole.create({ data: { name: `Exam Engine ${RUN}` } });
  roleId = role.id;
  driveOf[role.id] = await createDrive(role.id, { durationMinutes: 1, isOpen: true });
  await prisma.question.createMany({
    data: [
      { roundId: driveOf[role.id]!.roundId, text: 'Describe a market.', normalizedTextHash: `a-${RUN}`, maxMarks: 10, evaluatorGuidance: GUIDE, displayOrder: 1 },
      { roundId: driveOf[role.id]!.roundId, text: 'Explain risk.', normalizedTextHash: `b-${RUN}`, maxMarks: 15, evaluatorGuidance: GUIDE, displayOrder: 2 },
      { roundId: driveOf[role.id]!.roundId, text: 'Retired question.', normalizedTextHash: `c-${RUN}`, maxMarks: 5, displayOrder: 3, active: false },
    ],
  });
  const closed = await prisma.jobRole.create({ data: { name: `Exam Closed ${RUN}` } });
  closedRoleId = closed.id;
  driveOf[closed.id] = await createDrive(closed.id, { durationMinutes: 1, isOpen: false });
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) await makeCandidate(key, roleId);
  await makeCandidate('exempt', roleId, { locationExempt: true });
  await makeCandidate('closed', closedRoleId);
  app = createApp();
});

after(async () => {
  await closeAutoSubmitQueue();
  await prisma.$disconnect();
  await getRedis().quit();
});

const agents: Record<string, ReturnType<typeof request.agent>> = {};
const refreshCookies: Record<string, string> = {};

async function signIn(key: string) {
  const existing = agents[key];
  if (existing) return existing;
  const agent = request.agent(app);
  const identifier = emails[key];
  const r1 = await agent.post('/api/candidate/auth/request-otp').send({ identifier });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await agent.post('/api/candidate/auth/verify-otp').send({ identifier, code: '123456' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const raw = r2.headers['set-cookie'] as unknown;
  const rt = (Array.isArray(raw) ? (raw as string[]) : []).find((c) => c.startsWith('exam_cand_rt='));
  assert.ok(rt);
  refreshCookies[key] = rt.split(';')[0] ?? '';
  agents[key] = agent;
  return agent;
}

interface StateBody {
  attemptId: string;
  sessionId?: string;
  status: string;
  endsAt: string;
  startedAt: string;
  serverNow: string;
  durationMinutes: number;
  questions: {
    attemptQuestionId: string;
    order: number;
    text: string;
    maxMarks: number;
    answer: { text: string; wordCount: number; clientSeq: number; markedForReview: boolean; visited: boolean; lastSavedAt: string | null };
  }[];
}

async function start(key: string): Promise<StateBody> {
  const agent = await signIn(key);
  const res = await agent.post(`/api/candidate/exams/${ids[key]}/start`).send({ location: HERE });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data as StateBody;
}

const save = (key: string, aqId: string, body: Record<string, unknown>) =>
  agents[key]!.put(`/api/candidate/exams/${ids[key]}/answers/${aqId}`).send({ typedChars: 0, intervalMs: 0, ...body });

let stateA: StateBody;

test('start without a granted location is LOCATION_REQUIRED, and the EXAM_START row is still written', async () => {
  const agent = await signIn('a');
  const res = await agent.post(`/api/candidate/exams/${ids.a}/start`).send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'LOCATION_REQUIRED');
  const rows = await prisma.candidateLoginLog.findMany({ where: { candidateId: ids.a, stage: 'EXAM_START' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.permission, 'DENIED');
  assert.equal(await prisma.examAttempt.count({ where: { candidateId: ids.a } }), 0);
});

test('the first start sets questionsLocked', async () => {
  const before = await prisma.examRound.findUniqueOrThrow({ where: { id: driveOf[roleId]!.roundId } });
  assert.equal(before.questionsLocked, false);
  stateA = await start('a');
  const afterStart = await prisma.examRound.findUniqueOrThrow({ where: { id: driveOf[roleId]!.roundId } });
  assert.equal(afterStart.questionsLocked, true);
});

test('start with location returns the state: 2 active questions, a session id, no evaluator guidance anywhere', async () => {
  assert.equal(stateA.status, 'IN_PROGRESS');
  assert.equal(typeof stateA.sessionId, 'string');
  assert.equal(stateA.durationMinutes, 1);
  assert.equal(new Date(stateA.endsAt).getTime() - new Date(stateA.startedAt).getTime(), 60_000);
  assert.deepEqual(
    stateA.questions.map((q) => [q.order, q.text, q.maxMarks]),
    [
      [1, 'Describe a market.', 10],
      [2, 'Explain risk.', 15],
    ],
  );
  assert.deepEqual(stateA.questions[0]?.answer, { text: '', wordCount: 0, selectedOption: null, clientSeq: 0, markedForReview: false, visited: false, lastSavedAt: null });
  const raw = JSON.stringify(stateA);
  assert.ok(!raw.includes('evaluatorGuidance'));
  assert.ok(!raw.includes(GUIDE));
  const cand = await prisma.candidate.findUniqueOrThrow({ where: { id: ids.a } });
  assert.equal(cand.status, 'IN_PROGRESS');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { candidateId: ids.a } });
  assert.deepEqual(hist.map((h) => [h.fromStatus, h.toStatus]), [['NOT_STARTED', 'IN_PROGRESS']]);
  const started = await prisma.activityLog.count({ where: { candidateId: ids.a, eventType: 'EXAM_STARTED', attemptId: stateA.attemptId } });
  assert.equal(started, 1);
});

test('start enqueues the auto-submit job at endsAt + 10 s', async () => {
  const job = await getAutoSubmitQueue().getJob(`attempt-${stateA.attemptId}`);
  assert.ok(job, 'job exists');
  assert.equal(job.data.attemptId, stateA.attemptId);
  const due = job.timestamp + (job.opts.delay ?? 0);
  const expected = new Date(stateA.endsAt).getTime() + 10_000;
  assert.ok(Math.abs(due - expected) < 2_000, `due ${due} vs ${expected}`);
});

test('GET /exam returns the state without a session id', async () => {
  const res = await agents.a!.get(`/api/candidate/exams/${ids.a}/state`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.attemptId, stateA.attemptId);
  assert.ok(!('sessionId' in res.body.data));
  assert.ok(typeof res.body.data.serverNow === 'string');
});

test('starting twice returns the same attempt', async () => {
  const again = await start('a');
  assert.equal(again.attemptId, stateA.attemptId);
  assert.equal(again.endsAt, stateA.endsAt);
  stateA = again;
});

test('saveAnswer ignores lower clientSeq', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const s2 = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 2, text: 'bb', typedChars: 2, intervalMs: 1500, visited: true });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  assert.equal(s2.body.data.accepted, true);
  assert.ok(s2.body.data.lastSavedAt);
  const s1 = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 1, text: 'a', typedChars: 1, intervalMs: 1500 });
  assert.equal(s1.status, 200);
  assert.deepEqual(s1.body.data, { accepted: false, reason: 'STALE' });
  const stored = await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } });
  assert.equal(stored.text, 'bb');
  assert.equal(stored.clientSeq, 2);
  const state = await agents.a!.get(`/api/candidate/exams/${ids.a}/state`);
  const q = (state.body.data as StateBody).questions[0]!;
  assert.equal(q.answer.text, 'bb');
  assert.equal(q.answer.clientSeq, 2);
  assert.equal(q.answer.wordCount, 1);
  assert.equal(q.answer.visited, true);
  assert.ok(q.answer.lastSavedAt);
});

test('the first save writes a version; another within 30 s does not', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const answer = await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } });
  assert.equal(await prisma.answerVersion.count({ where: { answerId: answer.id } }), 1);
  await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 3, text: 'bbb', typedChars: 1, intervalMs: 1500 });
  assert.equal(await prisma.answerVersion.count({ where: { answerId: answer.id } }), 1);
});

test('a bulk insert is accepted but flagged with the numbers', async () => {
  const aq = stateA.questions[1]!.attemptQuestionId;
  const res = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 1, text: 'x'.repeat(600), typedChars: 0, intervalMs: 3000 });
  assert.equal(res.body.data.accepted, true);
  const ans = await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } });
  assert.equal(ans.bulkInsertFlags, 1);
  const log = await prisma.activityLog.findFirstOrThrow({ where: { attemptId: stateA.attemptId, eventType: 'SUSPICIOUS_BULK_INSERT' } });
  assert.deepEqual(log.metadata, { grown: 600, typed: 0, restored: 0, rate: 0, reasons: ['GROWTH_EXCEEDS_TYPED'] });
  assert.equal(log.questionId, aq);
});

test('rejects foreign session', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await save('a', aq, { sessionId: crypto.randomUUID(), clientSeq: 50, text: 'hijack' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'SESSION_SUPERSEDED');
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'bbb');
});

test('a malformed save is a 400 and over-long text is refused', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const bad = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 9, text: 'a'.repeat(20_001) });
  assert.equal(bad.status, 400);
  const neg = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 9, text: 'ok', typedChars: -1 });
  assert.equal(neg.status, 400);
});

test('resume issues new session, same endsAt', async () => {
  const old = stateA.sessionId;
  const res = await agents.a!.post(`/api/candidate/exams/${ids.a}/resume`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const resumed = res.body.data as StateBody;
  assert.equal(resumed.attemptId, stateA.attemptId);
  assert.equal(resumed.endsAt, stateA.endsAt);
  assert.ok(resumed.sessionId && resumed.sessionId !== old);
  const aq = stateA.questions[0]!.attemptQuestionId;
  const stale = await save('a', aq, { sessionId: old, clientSeq: 60, text: 'old tab' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'SESSION_SUPERSEDED');
  const fresh = await save('a', aq, { sessionId: resumed.sessionId, clientSeq: 4, text: 'bbbb', typedChars: 1, intervalMs: 1500 });
  assert.equal(fresh.body.data.accepted, true);
  // One from the repeated start, one from this resume.
  assert.equal(await prisma.activityLog.count({ where: { attemptId: stateA.attemptId, eventType: 'SESSION_TAKEOVER' } }), 2);
  stateA = resumed;
});

test("another candidate's attemptQuestionId is a 404", async () => {
  const stateB = await start('b');
  const foreign = stateB.questions[0]!.attemptQuestionId;
  const res = await save('a', foreign, { sessionId: stateA.sessionId, clientSeq: 1, text: 'not mine' });
  assert.equal(res.status, 404);
  const unknown = await save('a', crypto.randomUUID(), { sessionId: stateA.sessionId, clientSeq: 1, text: 'nobody' });
  assert.equal(unknown.status, 404);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: foreign } })).text, '');
});

test('a text/plain beacon saves with the same rules', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await agents.a!
    .post(`/api/candidate/exams/${ids.a}/answers/${aq}/beacon`)
    .set('Content-Type', 'text/plain;charset=UTF-8')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 5, text: 'beacon text', typedChars: 7, intervalMs: 2000 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'beacon text');
  const junk = await agents.a!.post(`/api/candidate/exams/${ids.a}/answers/${aq}/beacon`).set('Content-Type', 'text/plain').send('{not json');
  assert.equal(junk.status, 400);
});

test('a beacon after the access cookie expired is accepted on the live refresh cookie alone', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await request(app)
    .post(`/api/candidate/exams/${ids.a}/answers/${aq}/beacon`)
    .set('Cookie', refreshCookies.a!)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 6, text: 'after expiry', typedChars: 5, intervalMs: 2000 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'after expiry');
  const ev = await request(app)
    .post(`/api/candidate/exams/${ids.a}/events`)
    .set('Cookie', refreshCookies.a!)
    .send({ sessionId: stateA.sessionId, events: [{ type: 'PAGE_UNLOAD', at: new Date().toISOString() }] });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
});

test("a refresh cookie cannot write into another candidate's attempt, and no cookie is 401", async () => {
  await start('c');
  const stateC = (await agents.c!.get(`/api/candidate/exams/${ids.c}/state`)).body.data as StateBody;
  const res = await request(app)
    .post(`/api/candidate/exams/${ids.c}/answers/${stateC.questions[0]!.attemptQuestionId}/beacon`)
    .set('Cookie', refreshCookies.a!)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 1, text: 'cross', typedChars: 0, intervalMs: 0 }));
  assert.equal(res.status, 404);
  const none = await request(app)
    .post(`/api/candidate/exams/${ids.a}/answers/${stateA.questions[0]!.attemptQuestionId}/beacon`)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 99, text: 'anon', typedChars: 0, intervalMs: 0 }));
  assert.equal(none.status, 401);
});

test('a rotated refresh cookie no longer authenticates a beacon', async () => {
  const agent = await signIn('d');
  await start('d');
  const stateD = (await agent.get(`/api/candidate/exams/${ids.d}/state`)).body.data as StateBody;
  const sessionD = (await agent.post(`/api/candidate/exams/${ids.d}/resume`)).body.data.sessionId as string;
  const oldRt = refreshCookies.d!;
  const rotated = await agent.post('/api/candidate/auth/refresh');
  assert.equal(rotated.status, 200);
  const res = await request(app)
    .post(`/api/candidate/exams/${ids.d}/answers/${stateD.questions[0]!.attemptQuestionId}/beacon`)
    .set('Cookie', oldRt)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: sessionD, clientSeq: 1, text: 'replayed', typedChars: 0, intervalMs: 0 }));
  assert.equal(res.status, 401);
});

test('events are stored with the server time, the client time kept in metadata', async () => {
  const at = '2020-01-01T00:00:00.000Z';
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await agents.a!
    .post(`/api/candidate/exams/${ids.a}/events`)
    .send({ sessionId: stateA.sessionId, events: [{ type: 'PASTE_ATTEMPT', questionId: aq, at, metadata: { key: 'v' } }, { type: 'TAB_HIDDEN', at }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const paste = await prisma.activityLog.findFirstOrThrow({ where: { attemptId: stateA.attemptId, eventType: 'PASTE_ATTEMPT' } });
  assert.equal(paste.questionId, aq);
  assert.equal(paste.sessionId, stateA.sessionId);
  assert.ok(Date.now() - paste.createdAt.getTime() < 60_000);
  assert.deepEqual(paste.metadata, { clientAt: at, key: 'v' });
});

test('events: unknown types, more than 50, and a foreign session are refused', async () => {
  const at = new Date().toISOString();
  const bad = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).send({ sessionId: stateA.sessionId, events: [{ type: 'EXAM_SUBMITTED', at }] });
  assert.equal(bad.status, 400);
  const many = Array.from({ length: 51 }, () => ({ type: 'WINDOW_BLUR', at }));
  const tooMany = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).send({ sessionId: stateA.sessionId, events: many });
  assert.equal(tooMany.status, 400);
  const foreign = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).send({ sessionId: crypto.randomUUID(), events: [{ type: 'WINDOW_BLUR', at }] });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error.code, 'SESSION_SUPERSEDED');
});

test('an IP different from the last logged one is logged as IP_CHANGED', async () => {
  await prisma.activityLog.create({
    data: { candidateId: ids.a!, attemptId: stateA.attemptId, eventType: 'WINDOW_FOCUS', ip: '198.51.100.9' },
  });
  const res = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_FOCUS', at: new Date().toISOString() }] });
  assert.equal(res.status, 200);
  const changed = await prisma.activityLog.findFirstOrThrow({ where: { attemptId: stateA.attemptId, eventType: 'IP_CHANGED' } });
  assert.equal((changed.metadata as { from?: string }).from, '198.51.100.9');
  const again = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.equal(again.status, 200);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: stateA.attemptId, eventType: 'IP_CHANGED' } }), 1);
});

test('getFlags counts the integrity evidence and getFlagCounts batches it', async () => {
  const flags = await exam.getFlags(ids.a!);
  assert.deepEqual(flags.integrity, { pasteAttempts: 1, bulkInsert: 1, tabHidden: 1, blur: 1, ipChanges: 1 });
  assert.ok(Array.isArray(flags.location));
  const counts = await getFlagCounts([ids.a!, ids.e!]);
  assert.equal(counts.get(ids.e!), 0);
  // paste + bulk insert + IP change + location; one tab switch and one blur do not count
  assert.equal(counts.get(ids.a!), 3 + flags.location.length);
});

test('rejects after grace: a save past endsAt + 10 s is ATTEMPT_LOCKED and the stored text is unchanged', async () => {
  await prisma.examAttempt.update({ where: { id: stateA.attemptId }, data: { endsAt: new Date(Date.now() - 11_000) } });
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await save('a', aq, { sessionId: stateA.sessionId, clientSeq: 100, text: 'too late' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'ATTEMPT_LOCKED');
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'after expiry');
});

test('a save inside the 10 s grace is still accepted', async () => {
  const stateE = await start('e');
  await prisma.examAttempt.update({ where: { id: stateE.attemptId }, data: { endsAt: new Date(Date.now() - 5_000) } });
  const res = await save('e', stateE.questions[0]!.attemptQuestionId, { sessionId: stateE.sessionId, clientSeq: 1, text: 'just in time' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
});

test('autoSubmitAttempt does nothing before endsAt', async () => {
  const stateF = await start('f');
  assert.equal(await autoSubmitAttempt(stateF.attemptId), false);
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: stateF.attemptId } })).status, 'IN_PROGRESS');
});

test("a stale auto-submit for a RESET attempt never touches it or the candidate's new attempt", async () => {
  const old = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: ids.f, status: 'IN_PROGRESS' } });
  // What the Task 9 reset does: the old row becomes RESET (its BullMQ job is left behind).
  await prisma.examAttempt.update({ where: { id: old.id }, data: { status: 'RESET', endsAt: new Date(Date.now() - 60_000) } });
  await prisma.candidate.update({ where: { id: ids.f }, data: { status: 'NOT_STARTED' } });
  const fresh = await start('f');
  assert.notEqual(fresh.attemptId, old.id);
  assert.equal(await autoSubmitAttempt(old.id), false);
  await sweepExpiredAttempts();
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: old.id } })).status, 'RESET');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: fresh.attemptId } })).status, 'IN_PROGRESS');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: ids.f } })).status, 'IN_PROGRESS');
});

test('sweep auto-submits expired in-progress attempts', async () => {
  const attempt = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: ids.c, status: 'IN_PROGRESS' } });
  await prisma.examAttempt.update({ where: { id: attempt.id }, data: { endsAt: new Date(Date.now() - 20_000) } });
  await sweepExpiredAttempts();
  const done = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(done.status, 'AUTO_SUBMITTED');
  assert.equal(done.submitType, 'AUTO');
  assert.ok(done.submittedAt);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: ids.c } })).status, 'AUTO_SUBMITTED');
  assert.equal(await prisma.activityLog.count({ where: { attemptId: attempt.id, eventType: 'EXAM_AUTO_SUBMITTED' } }), 1);
  assert.equal(await autoSubmitAttempt(attempt.id), false, 'idempotent');
  assert.equal(await prisma.activityLog.count({ where: { attemptId: attempt.id, eventType: 'EXAM_AUTO_SUBMITTED' } }), 1);
});

test('manual submit, then save is ATTEMPT_LOCKED and a new start is ALREADY_ATTEMPTED', async () => {
  const stateB = (await agents.b!.post(`/api/candidate/exams/${ids.b}/resume`)).body.data as StateBody;
  const res = await agents.b!.post(`/api/candidate/exams/${ids.b}/submit`).send({ sessionId: stateB.sessionId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: stateB.attemptId } });
  assert.equal(attempt.status, 'SUBMITTED');
  assert.equal(attempt.submitType, 'MANUAL');
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: ids.b } })).status, 'SUBMITTED');
  assert.equal(await getAutoSubmitQueue().getJob(`attempt-${stateB.attemptId}`), undefined);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: stateB.attemptId, eventType: 'EXAM_SUBMITTED' } }), 1);
  const late = await save('b', stateB.questions[0]!.attemptQuestionId, { sessionId: stateB.sessionId, clientSeq: 1, text: 'after submit' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ATTEMPT_LOCKED');
  const again = await agents.b!.post(`/api/candidate/exams/${ids.b}/start`).send({ location: HERE });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
  const state = await agents.b!.get(`/api/candidate/exams/${ids.b}/state`);
  assert.equal(state.body.data.status, 'SUBMITTED');
});


test('GET /exam/summary after submit: receipt fields and counts only, never answer text', async () => {
  const attempt = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: ids.b, status: { not: 'RESET' } } });
  const answered = await prisma.answer.count({ where: { attemptQuestion: { attemptId: attempt.id }, wordCount: { gt: 0 } } });
  const total = await prisma.attemptQuestion.count({ where: { attemptId: attempt.id } });
  const res = await agents.b!.get(`/api/candidate/exams/${ids.b}/summary`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, {
    status: 'SUBMITTED',
    submitType: 'MANUAL',
    startedAt: attempt.startedAt.toISOString(),
    submittedAt: attempt.submittedAt!.toISOString(),
    questionCount: total,
    answeredCount: answered,
  });
  assert.ok(!JSON.stringify(res.body).includes('after submit'), 'no answer text in the summary');
});

test('GET /exams/:id/summary needs a session and an attempt', async () => {
  assert.equal((await request(app).get(`/api/candidate/exams/${crypto.randomUUID()}/summary`)).status, 401);
});

test('a location-exempt candidate starts without a location; a closed role is EXAM_NOT_OPEN', async () => {
  const exempt = await (await signIn('exempt')).post(`/api/candidate/exams/${ids.exempt}/start`).send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(exempt.status, 200, JSON.stringify(exempt.body));
  const closed = await (await signIn('closed')).post(`/api/candidate/exams/${ids.closed}/start`).send({ location: HERE });
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error.code, 'EXAM_NOT_OPEN');
  const none = await agents.closed!.get(`/api/candidate/exams/${ids.closed}/state`);
  assert.equal(none.status, 404);
});

// ---- fix round 1 ----------------------------------------------------------

/** Cookies for a candidate without the OTP round trip (keeps 100 sign-ins off the OTP rate limits). */
async function mintCookies(candidateId: string): Promise<string> {
  const rt = await issueRefreshToken('candidate', candidateId);
  const fam = await peekRefreshFamily('candidate', rt);
  assert.ok(fam);
  return `exam_cand_at=${signAccess('candidate', { sub: candidateId, fam })}; exam_cand_rt=${rt}`;
}

test('a superseded tab cannot submit; the attempt stays in progress', async () => {
  await makeCandidate('sup', roleId);
  const first = await start('sup');
  const second = (await agents.sup!.post(`/api/candidate/exams/${ids.sup}/resume`)).body.data as StateBody;
  assert.notEqual(first.sessionId, second.sessionId);
  const res = await agents.sup!.post(`/api/candidate/exams/${ids.sup}/submit`).send({ sessionId: first.sessionId });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'SESSION_SUPERSEDED');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: first.attemptId } })).status, 'IN_PROGRESS');
});

test('the beacon and events routes refuse cross-site requests with 403', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const body = JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 500, text: 'csrf', typedChars: 0, intervalMs: 0 });
  const evilOrigin = await agents.a!.post(`/api/candidate/exams/${ids.a}/answers/${aq}/beacon`).set('Origin', 'https://evil.example').set('Content-Type', 'text/plain').send(body);
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.body.error.code, 'FORBIDDEN');
  const crossSite = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).set('Sec-Fetch-Site', 'cross-site').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.equal(crossSite.status, 403);
  const sameSite = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).set('Sec-Fetch-Site', 'same-site').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.equal(sameSite.status, 403);
  assert.notEqual((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'csrf');
  // The real page: same origin, Origin = PUBLIC_WEB_URL. Gets past the guard (the attempt itself is locked by now).
  const ours = await agents.a!.post(`/api/candidate/exams/${ids.a}/events`).set('Origin', new URL(env.PUBLIC_WEB_URL).origin).set('Sec-Fetch-Site', 'same-origin').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.notEqual(ours.status, 403, JSON.stringify(ours.body));
});

test('100 concurrent starts for one role all succeed, and saves keep working meanwhile', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Burst ${RUN}` } });
  driveOf[role.id] = await createDrive(role.id, { durationMinutes: 30, isOpen: true });
  await prisma.question.createMany({
    data: [
      { roundId: driveOf[role.id]!.roundId, text: 'Burst one.', normalizedTextHash: `burst-a-${RUN}`, maxMarks: 10, displayOrder: 1 },
      { roundId: driveOf[role.id]!.roundId, text: 'Burst two.', normalizedTextHash: `burst-b-${RUN}`, maxMarks: 10, displayOrder: 2 },
    ],
  });
  const created = await createCandidates(
    Array.from({ length: 101 }, (_, i) => ({
      candidateCode: `B-${RUN}-${i}`,
      fullName: `Burst ${i}`,
      email: `burst${i}-${RUN}@exam.int.test`,
      mobile: mobile(),
      jobRoleId: role.id,
      driveId: driveOf[role.id]!.driveId,
    })),
  );
  const [early, ...rest] = created;
  const earlyCookie = await mintCookies(early!.id);
  const earlyStart = await request(app).post(`/api/candidate/exams/${early!.id}/start`).set('Cookie', earlyCookie).send({ location: HERE });
  assert.equal(earlyStart.status, 200, JSON.stringify(earlyStart.body));
  const earlyState = earlyStart.body.data as StateBody;
  const cookies = await Promise.all(rest.map((c) => mintCookies(c.id)));
  const restIds = rest.map((c) => c.id);

  const starts = cookies.map((cookie, i) => request(app).post(`/api/candidate/exams/${restIds[i]}/start`).set('Cookie', cookie).send({ location: HERE }));
  const saves = Array.from({ length: 20 }, (_, i) =>
    request(app)
      .put(`/api/candidate/exams/${early!.id}/answers/${earlyState.questions[0]!.attemptQuestionId}`)
      .set('Cookie', earlyCookie)
      .send({ sessionId: earlyState.sessionId, clientSeq: i + 1, text: `t${i}`, typedChars: 2, intervalMs: 2000 }),
  );
  const [startRes, saveRes] = await Promise.all([Promise.all(starts), Promise.all(saves)]);

  const bad = startRes.filter((r) => r.status !== 200).map((r) => `${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(bad, []);
  assert.deepEqual(saveRes.filter((r) => r.status !== 200).map((r) => r.status), []);
  assert.equal(await prisma.examAttempt.count({ where: { candidate: { jobRoleId: role.id } } }), 101);
  assert.equal((await prisma.examRound.findUniqueOrThrow({ where: { id: driveOf[role.id]!.roundId } })).questionsLocked, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: earlyState.questions[0]!.attemptQuestionId } })).clientSeq, 20);

  // Ruling: an already-submitted attempt is ALREADY_ATTEMPTED even once the exam has closed.
  const submit = await request(app).post(`/api/candidate/exams/${early!.id}/submit`).set('Cookie', earlyCookie).send({ sessionId: (await request(app).post(`/api/candidate/exams/${early!.id}/resume`).set('Cookie', earlyCookie)).body.data.sessionId });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  await prisma.drive.update({ where: { id: driveOf[role.id]!.driveId }, data: { isOpen: false } });
  const again = await request(app).post(`/api/candidate/exams/${early!.id}/start`).set('Cookie', earlyCookie).send({ location: HERE });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
});

// ---- final review fixes ---------------------------------------------------

test('I1: a repeated start of a running attempt resumes it after windowEnd and without a location', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Late ${RUN}` } });
  driveOf[role.id] = await createDrive(role.id, { durationMinutes: 30, isOpen: true });
  await prisma.question.create({ data: { roundId: driveOf[role.id]!.roundId, text: 'Late one.', normalizedTextHash: `late-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  await makeCandidate('late', role.id);
  const first = await start('late');
  // The window closes while the candidate is mid-exam (they keep their full duration).
  await prisma.drive.update({ where: { id: driveOf[role.id]!.driveId }, data: { windowEnd: new Date(Date.now() - 60_000) } });
  const afterWindow = await agents.late!.post(`/api/candidate/exams/${ids.late}/start`).send({ location: HERE });
  assert.equal(afterWindow.status, 200, JSON.stringify(afterWindow.body));
  assert.equal(afterWindow.body.data.attemptId, first.attemptId);
  assert.equal(afterWindow.body.data.endsAt, first.endsAt);
  assert.notEqual(afterWindow.body.data.sessionId, first.sessionId);
  // Location since switched off: still a resume, not LOCATION_REQUIRED.
  const noLocation = await agents.late!.post(`/api/candidate/exams/${ids.late}/start`).send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(noLocation.status, 200, JSON.stringify(noLocation.body));
  assert.equal(noLocation.body.data.attemptId, first.attemptId);
  // A candidate who never started still meets the closed window.
  await makeCandidate('latenew', role.id);
  const fresh = await (await signIn('latenew')).post(`/api/candidate/exams/${ids.latenew}/start`).send({ location: HERE });
  assert.equal(fresh.status, 403);
  assert.equal(fresh.body.error.code, 'EXAM_WINDOW_CLOSED');
});

test('I4: an Undo re-insertion sent as restoredChars is saved without a SUSPICIOUS_BULK_INSERT flag', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Undo ${RUN}` } });
  driveOf[role.id] = await createDrive(role.id, { durationMinutes: 30, isOpen: true });
  await prisma.question.create({ data: { roundId: driveOf[role.id]!.roundId, text: 'Undo one.', normalizedTextHash: `undo-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  await makeCandidate('undo', role.id);
  const st = await start('undo');
  const aq = st.questions[0]!.attemptQuestionId;
  const res = await save('undo', aq, { sessionId: st.sessionId, clientSeq: 1, text: 'y'.repeat(400), typedChars: 0, restoredChars: 400, intervalMs: 2000 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).bulkInsertFlags, 0);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: st.attemptId, eventType: 'SUSPICIOUS_BULK_INSERT' } }), 0);
});


// ---- multiple exams per account (docs/multi-exam.md) -----------------------

test('one exam at a time: starting a second application while the first runs is 409 ANOTHER_EXAM_IN_PROGRESS; after submit it starts; /exams reflects progress', async () => {
  const roleB = await prisma.jobRole.create({ data: { name: `Exam Multi B ${RUN}` } });
  driveOf[roleB.id] = await createDrive(roleB.id, { durationMinutes: 30, isOpen: true });
  await prisma.question.create({ data: { roundId: driveOf[roleB.id]!.roundId, text: 'Multi B.', normalizedTextHash: `multi-b-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  const first = await createCandidate({ candidateCode: `M-${RUN}-1`, fullName: 'Multi Person', email: `multi-${RUN}@exam.int.test`, mobile: mobile(), jobRoleId: roleId, driveId: driveOf[roleId]!.driveId, locationExempt: true });
  const second = await createApplication(first.id, { candidateCode: `M-${RUN}-2`, fullName: 'Multi Person', jobRoleId: roleB.id, driveId: driveOf[roleB.id]!.driveId, locationExempt: true });
  const cookie = await mintCookies(first.id);
  const DENIED = { location: { stage: 'EXAM_START', permission: 'DENIED' } };

  const started = await request(app).post(`/api/candidate/exams/${first.id}/start`).set('Cookie', cookie).send(DENIED);
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const blocked = await request(app).post(`/api/candidate/exams/${second.id}/start`).set('Cookie', cookie).send(DENIED);
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'ANOTHER_EXAM_IN_PROGRESS');
  assert.equal(await prisma.examAttempt.count({ where: { candidateId: second.id } }), 0);

  const mid = await request(app).get('/api/candidate/exams').set('Cookie', cookie);
  assert.deepEqual(mid.body.data.exams.map((e: { applicationId: string; progress: string }) => [e.applicationId, e.progress]).sort(), [
    [first.id, 'IN_PROGRESS'],
    [second.id, 'NOT_STARTED'],
  ].sort());

  const resumed = await request(app).post(`/api/candidate/exams/${first.id}/resume`).set('Cookie', cookie);
  const done = await request(app).post(`/api/candidate/exams/${first.id}/submit`).set('Cookie', cookie).send({ sessionId: resumed.body.data.sessionId });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const go = await request(app).post(`/api/candidate/exams/${second.id}/start`).set('Cookie', cookie).send(DENIED);
  assert.equal(go.status, 200, JSON.stringify(go.body));

  // An admin decision still reads as SUBMITTED to the candidate.
  await prisma.candidate.update({ where: { id: first.id }, data: { status: 'SHORTLISTED' } });
  const after = await request(app).get(`/api/candidate/exams/${first.id}`).set('Cookie', cookie);
  assert.equal(after.body.data.exam.progress, 'SUBMITTED');
  assert.equal(after.body.data.exam.attempt.status, 'SUBMITTED');
  assert.equal(JSON.stringify(after.body).includes('SHORTLISTED'), false);

  // Another account cannot reach the application.
  const stranger = await createCandidate({ candidateCode: `M-${RUN}-3`, fullName: 'Stranger', email: `stranger-${RUN}@exam.int.test`, mobile: mobile(), jobRoleId: roleId, driveId: driveOf[roleId]!.driveId });
  const theirs = await request(app).get(`/api/candidate/exams/${first.id}`).set('Cookie', await mintCookies(stranger.id));
  assert.equal(theirs.status, 404);
});


// ---- drives: one round, several colleges (spec 2026-11-10) ------------------

async function twoDriveRound(name: string) {
  const role = await prisma.jobRole.create({ data: { name: `${name} ${RUN}` } });
  const a = await createDrive(role.id, { durationMinutes: 30, isOpen: true, college: 'DRVA' });
  const b = await createDrive(role.id, { durationMinutes: 30, isOpen: false, college: 'DRVB' });
  await prisma.question.create({ data: { roundId: a.roundId, text: `${name} one.`, normalizedTextHash: `${name}-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  const person = async (key: string, driveId: string) =>
    createCandidate({ candidateCode: `D-${RUN}-${key}`, fullName: `Drive ${key}`, email: `${key}-${RUN}@exam.int.test`, mobile: mobile(), jobRoleId: role.id, driveId, locationExempt: true });
  return { role, a, b, person };
}
const DENIED_START = { location: { stage: 'EXAM_START', permission: 'DENIED' } };

test('two drives of one round: window open in A only → start in A ok, start in B 403 EXAM_NOT_OPEN', async () => {
  const { a, b, person } = await twoDriveRound('TwoDrives');
  const inA = await person('twoa', a.driveId);
  const inB = await person('twob', b.driveId);
  const okA = await request(app).post(`/api/candidate/exams/${inA.id}/start`).set('Cookie', await mintCookies(inA.id)).send(DENIED_START);
  assert.equal(okA.status, 200, JSON.stringify(okA.body));
  const noB = await request(app).post(`/api/candidate/exams/${inB.id}/start`).set('Cookie', await mintCookies(inB.id)).send(DENIED_START);
  assert.equal(noB.status, 403, JSON.stringify(noB.body));
  assert.equal(noB.body.error.code, 'EXAM_NOT_OPEN');
  // Drive B's own list entry shows B's switch, A's shows A's.
  const listB = await request(app).get('/api/candidate/exams').set('Cookie', await mintCookies(inB.id));
  assert.equal(listB.body.data.exams[0].isOpen, false);
  assert.equal(listB.body.data.exams[0].roundNumber, null);
  assert.equal(listB.body.data.exams[0].jobProfileType, 'PLACEMENT');
  assert.ok(!/college|DRVB/i.test(JSON.stringify(listB.body)), 'candidates never see the college');
});

test('start in drive A locks round questions for drive B', async () => {
  const { a, b, person } = await twoDriveRound('SharedLock');
  const inA = await person('locka', a.driveId);
  assert.equal((await prisma.examRound.findUniqueOrThrow({ where: { id: a.roundId } })).questionsLocked, false);
  const res = await request(app).post(`/api/candidate/exams/${inA.id}/start`).set('Cookie', await mintCookies(inA.id)).send(DENIED_START);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(a.roundId, b.roundId);
  assert.equal((await prisma.examRound.findUniqueOrThrow({ where: { id: b.roundId } })).questionsLocked, true);
});

test('resume after same-round move', async () => {
  const { a, b, person } = await twoDriveRound('MoveResume');
  const who = await person('mover', a.driveId);
  const cookie = await mintCookies(who.id);
  const started = await request(app).post(`/api/candidate/exams/${who.id}/start`).set('Cookie', cookie).send(DENIED_START);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  // An admin corrects the college: same round, so the running attempt stays valid.
  await prisma.candidate.update({ where: { id: who.id }, data: { driveId: b.driveId } });
  const resumed = await request(app).post(`/api/candidate/exams/${who.id}/resume`).set('Cookie', cookie);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.data.attemptId, started.body.data.attemptId);
  const done = await request(app).post(`/api/candidate/exams/${who.id}/submit`).set('Cookie', cookie).send({ sessionId: resumed.body.data.sessionId });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test('roundNumber shows on the candidate list once the job profile has two rounds; internship type is passed through', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Two Rounds ${RUN}`, type: 'INTERNSHIP' } });
  await createDrive(role.id, { roundNumber: 1, isOpen: false });
  const r2 = await createDrive(role.id, { roundNumber: 2, isOpen: false });
  const who = await createCandidate({ candidateCode: `R2-${RUN}`, fullName: 'Round Two', email: `r2-${RUN}@exam.int.test`, mobile: mobile(), jobRoleId: role.id, driveId: r2.driveId });
  const list = await request(app).get('/api/candidate/exams').set('Cookie', await mintCookies(who.id));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual([list.body.data.exams[0].roundNumber, list.body.data.exams[0].jobProfileType], [2, 'INTERNSHIP']);
});

// ---- MCQ questions (spec 2026-11-10 MCQ questions) ----------------------------------

async function mcqRound(name: string, opts: { written?: boolean; negative?: number } = {}) {
  const role = await prisma.jobRole.create({ data: { name: `${name} ${RUN}` } });
  const d = await createDrive(role.id, { durationMinutes: 30, isOpen: true, college: 'MCQC' });
  if (opts.negative) await prisma.examRound.update({ where: { id: d.roundId }, data: { mcqNegativeMarks: opts.negative } });
  await prisma.question.createMany({
    data: [
      { roundId: d.roundId, type: 'MCQ', text: `${name} prime?`, normalizedTextHash: `${name}-m1-${RUN}`, maxMarks: 2, options: ['4', '6', '7', '9'], correctOption: 2, displayOrder: 1 },
      { roundId: d.roundId, type: 'MCQ', text: `${name} even?`, normalizedTextHash: `${name}-m2-${RUN}`, maxMarks: 1, options: ['3', '5', '8', '11'], correctOption: 2, displayOrder: 2 },
      ...(opts.written === false ? [] : [{ roundId: d.roundId, text: `${name} explain.`, normalizedTextHash: `${name}-w-${RUN}`, maxMarks: 5, displayOrder: 0 }]),
    ],
  });
  const who = await createCandidate({ candidateCode: `MQ-${RUN}-${name}`, fullName: `Mcq ${name}`, email: `mcq-${name.toLowerCase()}-${RUN}@exam.int.test`, mobile: mobile(), jobRoleId: role.id, driveId: d.driveId, locationExempt: true });
  return { role, d, who, cookie: await mintCookies(who.id) };
}

test('candidate payloads never reveal the correct option', async () => {
  const { who, cookie } = await mcqRound('McqLeak', { negative: 0.25 });
  const start = await request(app).post(`/api/candidate/exams/${who.id}/start`).set('Cookie', cookie).send(DENIED_START);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const qs = start.body.data.questions as { type: string; options: string[]; answer: { selectedOption: number | null } }[];
  assert.deepEqual(qs.map((q) => q.type), ['MCQ', 'MCQ', 'WRITTEN']);
  assert.deepEqual([...qs[0]!.options].sort().length, 4);
  assert.equal(qs[0]!.answer.selectedOption, null);
  assert.equal(start.body.data.mcqNegativeMarks, 0.25);
  const payloads = [
    start.body,
    (await request(app).post(`/api/candidate/exams/${who.id}/resume`).set('Cookie', cookie)).body,
    (await request(app).get(`/api/candidate/exams/${who.id}/state`).set('Cookie', cookie)).body,
    (await request(app).get(`/api/candidate/exams/${who.id}/summary`).set('Cookie', cookie)).body,
    (await request(app).get('/api/candidate/exams').set('Cookie', cookie)).body,
    (await request(app).get(`/api/candidate/exams/${who.id}`).set('Cookie', cookie)).body,
  ];
  for (const p of payloads) assert.ok(!/correct|autoMarks|mcqMarks/i.test(JSON.stringify(p)), JSON.stringify(p).slice(0, 300));
  const list = payloads[4] as { data: { exams: { mcqNegativeMarks: number }[] } };
  assert.equal(list.data.exams[0]!.mcqNegativeMarks, 0.25);
  // The stored snapshot keeps the correct answer in the shown order.
  const aqs = await prisma.attemptQuestion.findMany({ where: { attempt: { candidateId: who.id } }, orderBy: { order: 'asc' } });
  const prime = aqs.find((q) => q.textSnapshot.endsWith('prime?'))!;
  assert.equal(prime.optionsSnapshot[prime.correctSnapshot!], '7');
  assert.equal(Number(prime.negativeMarksSnapshot), 0.25);
});

test('choice save follows the answer save rules', async () => {
  const { who, cookie } = await mcqRound('McqSave');
  const start = await request(app).post(`/api/candidate/exams/${who.id}/start`).set('Cookie', cookie).send(DENIED_START);
  const sid = start.body.data.sessionId as string;
  const [mq, , wq] = start.body.data.questions as { attemptQuestionId: string }[];
  const choice = (aq: string, body: object) => request(app).put(`/api/candidate/exams/${who.id}/answers/${aq}/choice`).set('Cookie', cookie).send({ sessionId: sid, ...body });
  const ok = await choice(mq!.attemptQuestionId, { clientSeq: 1, selectedOption: 3 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.accepted, true);
  assert.equal((await choice(mq!.attemptQuestionId, { clientSeq: 1, selectedOption: 0 })).body.data.reason, 'STALE');
  assert.equal((await choice(wq!.attemptQuestionId, { clientSeq: 1, selectedOption: 0 })).status, 400, 'no choice on a written question');
  const text = await request(app).put(`/api/candidate/exams/${who.id}/answers/${mq!.attemptQuestionId}`).set('Cookie', cookie)
    .send({ sessionId: sid, clientSeq: 2, text: 'hello', typedChars: 5, intervalMs: 2000 });
  assert.equal(text.status, 400, 'no text on an MCQ');
  const cleared = await choice(mq!.attemptQuestionId, { clientSeq: 2, selectedOption: null });
  assert.equal(cleared.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: mq!.attemptQuestionId } })).selectedOption, null);
  await choice(mq!.attemptQuestionId, { clientSeq: 3, selectedOption: 1 });
  const summary = await request(app).get(`/api/candidate/exams/${who.id}/summary`).set('Cookie', cookie);
  assert.equal(summary.body.data.answeredCount, 1, 'a chosen MCQ counts as answered');
  // A resumed session supersedes the old one.
  const resumed = await request(app).post(`/api/candidate/exams/${who.id}/resume`).set('Cookie', cookie);
  const superseded = await choice(mq!.attemptQuestionId, { clientSeq: 4, selectedOption: 2 });
  assert.equal(superseded.status, 409);
  assert.equal(superseded.body.error.code, 'SESSION_SUPERSEDED');
  // After submit the choice is locked.
  const newSid = resumed.body.data.sessionId as string;
  assert.equal((await request(app).post(`/api/candidate/exams/${who.id}/submit`).set('Cookie', cookie).send({ sessionId: newSid })).status, 200);
  const late = await request(app).put(`/api/candidate/exams/${who.id}/answers/${mq!.attemptQuestionId}/choice`).set('Cookie', cookie).send({ sessionId: newSid, clientSeq: 9, selectedOption: 2 });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ATTEMPT_LOCKED');
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: mq!.attemptQuestionId } })).selectedOption, 1);
});

test('submit auto-marks MCQs in a mixed test and leaves it for the evaluator', async () => {
  const { who, cookie } = await mcqRound('McqMixed', { negative: 0.5 });
  const start = await request(app).post(`/api/candidate/exams/${who.id}/start`).set('Cookie', cookie).send(DENIED_START);
  const sid = start.body.data.sessionId as string;
  const qs = start.body.data.questions as { attemptQuestionId: string; type: string; text: string; options: string[] }[];
  const prime = qs.find((q) => q.text.endsWith('prime?'))!;
  const even = qs.find((q) => q.text.endsWith('even?'))!;
  const put = (aq: string, seq: number, selectedOption: number) =>
    request(app).put(`/api/candidate/exams/${who.id}/answers/${aq}/choice`).set('Cookie', cookie).send({ sessionId: sid, clientSeq: seq, selectedOption });
  await put(prime.attemptQuestionId, 1, prime.options.indexOf('7')); // right: +2
  await put(even.attemptQuestionId, 1, even.options.indexOf('3')); // wrong: -0.5
  assert.equal((await request(app).post(`/api/candidate/exams/${who.id}/submit`).set('Cookie', cookie).send({ sessionId: sid })).status, 200);
  const attempt = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: who.id }, include: { questions: true, evaluation: true } });
  assert.deepEqual([Number(attempt.mcqMarks), Number(attempt.mcqMaxMarks)], [1.5, 3]);
  const marks = Object.fromEntries(attempt.questions.map((q) => [q.textSnapshot, q.autoMarks === null ? null : Number(q.autoMarks)]));
  assert.deepEqual(marks, { 'McqMixed prime?': 2, 'McqMixed even?': -0.5, 'McqMixed explain.': null });
  assert.equal(attempt.evaluation, null, 'written answers still need an evaluator');
  assert.equal(attempt.totalMarks, null);
  assert.equal((await prisma.candidate.findUniqueOrThrow({ where: { id: who.id } })).status, 'SUBMITTED');
});

test('auto-submit auto-marks and auto-evaluates an MCQ-only attempt', async () => {
  const { who, cookie } = await mcqRound('McqOnly', { written: false, negative: 0.5 });
  const start = await request(app).post(`/api/candidate/exams/${who.id}/start`).set('Cookie', cookie).send(DENIED_START);
  const sid = start.body.data.sessionId as string;
  const qs = start.body.data.questions as { attemptQuestionId: string; text: string; options: string[] }[];
  const prime = qs.find((q) => q.text.endsWith('prime?'))!;
  await request(app).put(`/api/candidate/exams/${who.id}/answers/${prime.attemptQuestionId}/choice`).set('Cookie', cookie)
    .send({ sessionId: sid, clientSeq: 1, selectedOption: prime.options.indexOf('4') }); // wrong: -0.5, other unanswered
  // Time runs out.
  const attemptId = start.body.data.attemptId as string;
  await prisma.examAttempt.update({ where: { id: attemptId }, data: { endsAt: new Date(Date.now() - 60_000) } });
  assert.equal(await autoSubmitAttempt(attemptId), true);
  const a = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { evaluation: true } });
  assert.equal(a.status, 'AUTO_SUBMITTED');
  assert.deepEqual([Number(a.mcqMarks), Number(a.mcqMaxMarks)], [-0.5, 3]);
  assert.equal(a.evaluation?.status, 'SUBMITTED');
  assert.equal(a.evaluation?.evaluatorId, null);
  assert.deepEqual([Number(a.totalMarks), Number(a.maxMarks), Number(a.percentage)], [0, 3, 0], 'total floored at 0');
  const c = await prisma.candidate.findUniqueOrThrow({ where: { id: who.id } });
  assert.equal(c.status, 'EVALUATED');
  const history = await prisma.candidateStatusHistory.findFirstOrThrow({ where: { candidateId: who.id, toStatus: 'EVALUATED' } });
  assert.equal(history.comment, 'Auto-marked (MCQ only)');
  assert.equal(await prisma.activityLog.count({ where: { attemptId, eventType: 'EXAM_AUTO_MARKED' } }), 1);
});
