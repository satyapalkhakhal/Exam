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
import { issueRefreshToken, peekRefreshFamily, signAccess } from '../../src/modules/adminAuth/tokens.js';

const RUN = crypto.randomBytes(4).toString('hex');
const GUIDE = `SECRET-GUIDE-${RUN}`;
const HERE = { stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.144, longitude: 91.736, accuracyM: 25 } as const;

let app: Express;
let roleId = '';
let closedRoleId = '';
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};

const mobile = () => `9${crypto.randomInt(100_000_000, 999_999_999)}`;

async function makeCandidate(key: string, jobRoleId: string, extra: { locationExempt?: boolean } = {}) {
  const email = `${key}-${RUN}@exam.int.test`;
  const c = await prisma.candidate.create({
    data: { candidateCode: `X-${RUN}-${key}`, fullName: `Exam ${key}`, email, mobile: mobile(), jobRoleId, ...extra },
  });
  emails[key] = email;
  ids[key] = c.id;
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  const role = await prisma.jobRole.create({ data: { name: `Exam Engine ${RUN}` } });
  roleId = role.id;
  await prisma.examSetting.create({ data: { jobRoleId: role.id, durationMinutes: 1, isOpen: true } });
  await prisma.question.createMany({
    data: [
      { jobRoleId: role.id, text: 'Describe a market.', normalizedTextHash: `a-${RUN}`, maxMarks: 10, evaluatorGuidance: GUIDE, displayOrder: 1 },
      { jobRoleId: role.id, text: 'Explain risk.', normalizedTextHash: `b-${RUN}`, maxMarks: 15, evaluatorGuidance: GUIDE, displayOrder: 2 },
      { jobRoleId: role.id, text: 'Retired question.', normalizedTextHash: `c-${RUN}`, maxMarks: 5, displayOrder: 3, active: false },
    ],
  });
  const closed = await prisma.jobRole.create({ data: { name: `Exam Closed ${RUN}` } });
  closedRoleId = closed.id;
  await prisma.examSetting.create({ data: { jobRoleId: closed.id, durationMinutes: 1, isOpen: false } });
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
  const res = await agent.post('/api/candidate/exam/start').send({ location: HERE });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data as StateBody;
}

const save = (key: string, aqId: string, body: Record<string, unknown>) =>
  agents[key]!.put(`/api/candidate/exam/answers/${aqId}`).send({ typedChars: 0, intervalMs: 0, ...body });

let stateA: StateBody;

test('start without a granted location is LOCATION_REQUIRED, and the EXAM_START row is still written', async () => {
  const agent = await signIn('a');
  const res = await agent.post('/api/candidate/exam/start').send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'LOCATION_REQUIRED');
  const rows = await prisma.candidateLoginLog.findMany({ where: { candidateId: ids.a, stage: 'EXAM_START' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.permission, 'DENIED');
  assert.equal(await prisma.examAttempt.count({ where: { candidateId: ids.a } }), 0);
});

test('the first start sets questionsLocked', async () => {
  const before = await prisma.examSetting.findUniqueOrThrow({ where: { jobRoleId: roleId } });
  assert.equal(before.questionsLocked, false);
  stateA = await start('a');
  const afterStart = await prisma.examSetting.findUniqueOrThrow({ where: { jobRoleId: roleId } });
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
  assert.deepEqual(stateA.questions[0]?.answer, { text: '', wordCount: 0, clientSeq: 0, markedForReview: false, visited: false, lastSavedAt: null });
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
  const res = await agents.a!.get('/api/candidate/exam');
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
  const state = await agents.a!.get('/api/candidate/exam');
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
  const res = await agents.a!.post('/api/candidate/exam/resume');
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
    .post(`/api/candidate/exam/answers/${aq}/beacon`)
    .set('Content-Type', 'text/plain;charset=UTF-8')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 5, text: 'beacon text', typedChars: 7, intervalMs: 2000 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'beacon text');
  const junk = await agents.a!.post(`/api/candidate/exam/answers/${aq}/beacon`).set('Content-Type', 'text/plain').send('{not json');
  assert.equal(junk.status, 400);
});

test('a beacon after the access cookie expired is accepted on the live refresh cookie alone', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await request(app)
    .post(`/api/candidate/exam/answers/${aq}/beacon`)
    .set('Cookie', refreshCookies.a!)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 6, text: 'after expiry', typedChars: 5, intervalMs: 2000 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'after expiry');
  const ev = await request(app)
    .post('/api/candidate/exam/events')
    .set('Cookie', refreshCookies.a!)
    .send({ sessionId: stateA.sessionId, events: [{ type: 'PAGE_UNLOAD', at: new Date().toISOString() }] });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
});

test("a refresh cookie cannot write into another candidate's attempt, and no cookie is 401", async () => {
  await start('c');
  const stateC = (await agents.c!.get('/api/candidate/exam')).body.data as StateBody;
  const res = await request(app)
    .post(`/api/candidate/exam/answers/${stateC.questions[0]!.attemptQuestionId}/beacon`)
    .set('Cookie', refreshCookies.a!)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 1, text: 'cross', typedChars: 0, intervalMs: 0 }));
  assert.equal(res.status, 404);
  const none = await request(app)
    .post(`/api/candidate/exam/answers/${stateA.questions[0]!.attemptQuestionId}/beacon`)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 99, text: 'anon', typedChars: 0, intervalMs: 0 }));
  assert.equal(none.status, 401);
});

test('a rotated refresh cookie no longer authenticates a beacon', async () => {
  const agent = await signIn('d');
  await start('d');
  const stateD = (await agent.get('/api/candidate/exam')).body.data as StateBody;
  const sessionD = (await agent.post('/api/candidate/exam/resume')).body.data.sessionId as string;
  const oldRt = refreshCookies.d!;
  const rotated = await agent.post('/api/candidate/auth/refresh');
  assert.equal(rotated.status, 200);
  const res = await request(app)
    .post(`/api/candidate/exam/answers/${stateD.questions[0]!.attemptQuestionId}/beacon`)
    .set('Cookie', oldRt)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ sessionId: sessionD, clientSeq: 1, text: 'replayed', typedChars: 0, intervalMs: 0 }));
  assert.equal(res.status, 401);
});

test('events are stored with the server time, the client time kept in metadata', async () => {
  const at = '2020-01-01T00:00:00.000Z';
  const aq = stateA.questions[0]!.attemptQuestionId;
  const res = await agents.a!
    .post('/api/candidate/exam/events')
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
  const bad = await agents.a!.post('/api/candidate/exam/events').send({ sessionId: stateA.sessionId, events: [{ type: 'EXAM_SUBMITTED', at }] });
  assert.equal(bad.status, 400);
  const many = Array.from({ length: 51 }, () => ({ type: 'WINDOW_BLUR', at }));
  const tooMany = await agents.a!.post('/api/candidate/exam/events').send({ sessionId: stateA.sessionId, events: many });
  assert.equal(tooMany.status, 400);
  const foreign = await agents.a!.post('/api/candidate/exam/events').send({ sessionId: crypto.randomUUID(), events: [{ type: 'WINDOW_BLUR', at }] });
  assert.equal(foreign.status, 409);
  assert.equal(foreign.body.error.code, 'SESSION_SUPERSEDED');
});

test('an IP different from the last logged one is logged as IP_CHANGED', async () => {
  await prisma.activityLog.create({
    data: { candidateId: ids.a!, attemptId: stateA.attemptId, eventType: 'WINDOW_FOCUS', ip: '198.51.100.9' },
  });
  const res = await agents.a!.post('/api/candidate/exam/events').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_FOCUS', at: new Date().toISOString() }] });
  assert.equal(res.status, 200);
  const changed = await prisma.activityLog.findFirstOrThrow({ where: { attemptId: stateA.attemptId, eventType: 'IP_CHANGED' } });
  assert.equal((changed.metadata as { from?: string }).from, '198.51.100.9');
  const again = await agents.a!.post('/api/candidate/exam/events').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
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
  const stateB = (await agents.b!.post('/api/candidate/exam/resume')).body.data as StateBody;
  const res = await agents.b!.post('/api/candidate/exam/submit').send({ sessionId: stateB.sessionId });
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
  const again = await agents.b!.post('/api/candidate/exam/start').send({ location: HERE });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
  const state = await agents.b!.get('/api/candidate/exam');
  assert.equal(state.body.data.status, 'SUBMITTED');
});


test('GET /exam/summary after submit: receipt fields and counts only, never answer text', async () => {
  const attempt = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: ids.b, status: { not: 'RESET' } } });
  const answered = await prisma.answer.count({ where: { attemptQuestion: { attemptId: attempt.id }, wordCount: { gt: 0 } } });
  const total = await prisma.attemptQuestion.count({ where: { attemptId: attempt.id } });
  const res = await agents.b!.get('/api/candidate/exam/summary');
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

test('GET /exam/summary needs a session and an attempt', async () => {
  assert.equal((await request(app).get('/api/candidate/exam/summary')).status, 401);
});

test('a location-exempt candidate starts without a location; a closed role is EXAM_NOT_OPEN', async () => {
  const exempt = await (await signIn('exempt')).post('/api/candidate/exam/start').send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(exempt.status, 200, JSON.stringify(exempt.body));
  const closed = await (await signIn('closed')).post('/api/candidate/exam/start').send({ location: HERE });
  assert.equal(closed.status, 403);
  assert.equal(closed.body.error.code, 'EXAM_NOT_OPEN');
  const none = await agents.closed!.get('/api/candidate/exam');
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
  const second = (await agents.sup!.post('/api/candidate/exam/resume')).body.data as StateBody;
  assert.notEqual(first.sessionId, second.sessionId);
  const res = await agents.sup!.post('/api/candidate/exam/submit').send({ sessionId: first.sessionId });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'SESSION_SUPERSEDED');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: first.attemptId } })).status, 'IN_PROGRESS');
});

test('the beacon and events routes refuse cross-site requests with 403', async () => {
  const aq = stateA.questions[0]!.attemptQuestionId;
  const body = JSON.stringify({ sessionId: stateA.sessionId, clientSeq: 500, text: 'csrf', typedChars: 0, intervalMs: 0 });
  const evilOrigin = await agents.a!.post(`/api/candidate/exam/answers/${aq}/beacon`).set('Origin', 'https://evil.example').set('Content-Type', 'text/plain').send(body);
  assert.equal(evilOrigin.status, 403);
  assert.equal(evilOrigin.body.error.code, 'FORBIDDEN');
  const crossSite = await agents.a!.post('/api/candidate/exam/events').set('Sec-Fetch-Site', 'cross-site').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.equal(crossSite.status, 403);
  const sameSite = await agents.a!.post('/api/candidate/exam/events').set('Sec-Fetch-Site', 'same-site').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.equal(sameSite.status, 403);
  assert.notEqual((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).text, 'csrf');
  // The real page: same origin, Origin = PUBLIC_WEB_URL. Gets past the guard (the attempt itself is locked by now).
  const ours = await agents.a!.post('/api/candidate/exam/events').set('Origin', new URL(env.PUBLIC_WEB_URL).origin).set('Sec-Fetch-Site', 'same-origin').send({ sessionId: stateA.sessionId, events: [{ type: 'WINDOW_BLUR', at: new Date().toISOString() }] });
  assert.notEqual(ours.status, 403, JSON.stringify(ours.body));
});

test('100 concurrent starts for one role all succeed, and saves keep working meanwhile', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Burst ${RUN}` } });
  await prisma.examSetting.create({ data: { jobRoleId: role.id, durationMinutes: 30, isOpen: true } });
  await prisma.question.createMany({
    data: [
      { jobRoleId: role.id, text: 'Burst one.', normalizedTextHash: `burst-a-${RUN}`, maxMarks: 10, displayOrder: 1 },
      { jobRoleId: role.id, text: 'Burst two.', normalizedTextHash: `burst-b-${RUN}`, maxMarks: 10, displayOrder: 2 },
    ],
  });
  const created = await prisma.candidate.createManyAndReturn({
    data: Array.from({ length: 101 }, (_, i) => ({
      candidateCode: `B-${RUN}-${i}`,
      fullName: `Burst ${i}`,
      email: `burst${i}-${RUN}@exam.int.test`,
      mobile: mobile(),
      jobRoleId: role.id,
    })),
    select: { id: true },
  });
  const [early, ...rest] = created;
  const earlyCookie = await mintCookies(early!.id);
  const earlyStart = await request(app).post('/api/candidate/exam/start').set('Cookie', earlyCookie).send({ location: HERE });
  assert.equal(earlyStart.status, 200, JSON.stringify(earlyStart.body));
  const earlyState = earlyStart.body.data as StateBody;
  const cookies = await Promise.all(rest.map((c) => mintCookies(c.id)));

  const starts = cookies.map((cookie) => request(app).post('/api/candidate/exam/start').set('Cookie', cookie).send({ location: HERE }));
  const saves = Array.from({ length: 20 }, (_, i) =>
    request(app)
      .put(`/api/candidate/exam/answers/${earlyState.questions[0]!.attemptQuestionId}`)
      .set('Cookie', earlyCookie)
      .send({ sessionId: earlyState.sessionId, clientSeq: i + 1, text: `t${i}`, typedChars: 2, intervalMs: 2000 }),
  );
  const [startRes, saveRes] = await Promise.all([Promise.all(starts), Promise.all(saves)]);

  const bad = startRes.filter((r) => r.status !== 200).map((r) => `${r.status} ${JSON.stringify(r.body)}`);
  assert.deepEqual(bad, []);
  assert.deepEqual(saveRes.filter((r) => r.status !== 200).map((r) => r.status), []);
  assert.equal(await prisma.examAttempt.count({ where: { candidate: { jobRoleId: role.id } } }), 101);
  assert.equal((await prisma.examSetting.findUniqueOrThrow({ where: { jobRoleId: role.id } })).questionsLocked, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: earlyState.questions[0]!.attemptQuestionId } })).clientSeq, 20);

  // Ruling: an already-submitted attempt is ALREADY_ATTEMPTED even once the exam has closed.
  const submit = await request(app).post('/api/candidate/exam/submit').set('Cookie', earlyCookie).send({ sessionId: (await request(app).post('/api/candidate/exam/resume').set('Cookie', earlyCookie)).body.data.sessionId });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  await prisma.examSetting.update({ where: { jobRoleId: role.id }, data: { isOpen: false } });
  const again = await request(app).post('/api/candidate/exam/start').set('Cookie', earlyCookie).send({ location: HERE });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
});

// ---- final review fixes ---------------------------------------------------

test('I1: a repeated start of a running attempt resumes it after windowEnd and without a location', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Late ${RUN}` } });
  await prisma.examSetting.create({ data: { jobRoleId: role.id, durationMinutes: 30, isOpen: true } });
  await prisma.question.create({ data: { jobRoleId: role.id, text: 'Late one.', normalizedTextHash: `late-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  await makeCandidate('late', role.id);
  const first = await start('late');
  // The window closes while the candidate is mid-exam (they keep their full duration).
  await prisma.examSetting.update({ where: { jobRoleId: role.id }, data: { windowEnd: new Date(Date.now() - 60_000) } });
  const afterWindow = await agents.late!.post('/api/candidate/exam/start').send({ location: HERE });
  assert.equal(afterWindow.status, 200, JSON.stringify(afterWindow.body));
  assert.equal(afterWindow.body.data.attemptId, first.attemptId);
  assert.equal(afterWindow.body.data.endsAt, first.endsAt);
  assert.notEqual(afterWindow.body.data.sessionId, first.sessionId);
  // Location since switched off: still a resume, not LOCATION_REQUIRED.
  const noLocation = await agents.late!.post('/api/candidate/exam/start').send({ location: { stage: 'EXAM_START', permission: 'DENIED' } });
  assert.equal(noLocation.status, 200, JSON.stringify(noLocation.body));
  assert.equal(noLocation.body.data.attemptId, first.attemptId);
  // A candidate who never started still meets the closed window.
  await makeCandidate('latenew', role.id);
  const fresh = await (await signIn('latenew')).post('/api/candidate/exam/start').send({ location: HERE });
  assert.equal(fresh.status, 403);
  assert.equal(fresh.body.error.code, 'EXAM_WINDOW_CLOSED');
});

test('I4: an Undo re-insertion sent as restoredChars is saved without a SUSPICIOUS_BULK_INSERT flag', async () => {
  const role = await prisma.jobRole.create({ data: { name: `Exam Undo ${RUN}` } });
  await prisma.examSetting.create({ data: { jobRoleId: role.id, durationMinutes: 30, isOpen: true } });
  await prisma.question.create({ data: { jobRoleId: role.id, text: 'Undo one.', normalizedTextHash: `undo-${RUN}`, maxMarks: 10, displayOrder: 1 } });
  await makeCandidate('undo', role.id);
  const st = await start('undo');
  const aq = st.questions[0]!.attemptQuestionId;
  const res = await save('undo', aq, { sessionId: st.sessionId, clientSeq: 1, text: 'y'.repeat(400), typedChars: 0, restoredChars: 400, intervalMs: 2000 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).bulkInsertFlags, 0);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: st.attemptId, eventType: 'SUSPICIOUS_BULK_INSERT' } }), 0);
});
