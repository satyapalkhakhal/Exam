// The exam engine end to end against exam_test and Redis db 15: start by round
// entry (with the location gate, the round lock and the one-exam-at-a-time
// rule), the candidate's round cards, the state read, autosave ordering, single
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
import { isCandidateInProgressViolation } from '../../src/modules/exam/exam.repository.js';
import { sweepExpiredAttempts } from '../../src/infrastructure/queue/sweep.js';
import { closeAutoSubmitQueue, getAutoSubmitQueue } from '../../src/infrastructure/queue/autoSubmit.queue.js';
import { issueRefreshToken, peekRefreshFamily, signAccess } from '../../src/modules/adminAuth/tokens.js';

const RUN = crypto.randomBytes(4).toString('hex');
const GUIDE = `SECRET-GUIDE-${RUN}`;
const HERE = { stage: 'EXAM_START', permission: 'GRANTED', latitude: 26.144, longitude: 91.736, accuracyM: 25 } as const;

let app: Express;
let roundId = '';
let closedRoundId = '';
const emails: Record<string, string> = {};
const ids: Record<string, string> = {};
/** The candidate's round entry used by start(key). */
const entries: Record<string, string> = {};

const mobile = () => `9${crypto.randomInt(100_000_000, 999_999_999)}`;

interface RoundSeed {
  durationMinutes?: number;
  isOpen?: boolean;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  instructions?: string;
}

/** A job profile with one exam whose Round 1 has the given settings and questions. */
async function makeExam(label: string, round: RoundSeed = {}, questions: { text: string; maxMarks?: number; guidance?: string; active?: boolean }[] = [{ text: `${label} one.` }]) {
  const role = await prisma.jobRole.create({ data: { name: `${label} Profile ${RUN}` } });
  const examRow = await prisma.exam.create({ data: { jobRoleId: role.id, name: `${label} ${RUN}` } });
  const r = await prisma.examRound.create({
    data: { examId: examRow.id, roundNumber: 1, durationMinutes: 1, isOpen: true, ...round },
  });
  await prisma.question.createMany({
    data: questions.map((q, i) => ({
      roundId: r.id,
      text: q.text,
      normalizedTextHash: `${label}-${i}-${RUN}`,
      maxMarks: q.maxMarks ?? 10,
      evaluatorGuidance: q.guidance ?? null,
      displayOrder: i + 1,
      active: q.active ?? true,
    })),
  });
  return { roleId: role.id, examId: examRow.id, roundId: r.id, examName: examRow.name };
}

/** Registers the person for the round's exam (if needed) and creates the round entry. */
async function enter(candidateId: string, forRoundId: string): Promise<string> {
  const r = await prisma.examRound.findUniqueOrThrow({ where: { id: forRoundId }, select: { examId: true } });
  const reg = await prisma.examRegistration.upsert({
    where: { candidateId_examId: { candidateId, examId: r.examId } },
    create: { candidateId, examId: r.examId },
    update: {},
  });
  const entry = await prisma.roundEntry.create({ data: { registrationId: reg.id, roundId: forRoundId } });
  return entry.id;
}

async function makeCandidate(key: string, forRoundId: string, extra: { locationExempt?: boolean } = {}) {
  const email = `${key}-${RUN}@exam.int.test`;
  const c = await prisma.candidate.create({
    data: { candidateCode: `X-${RUN}-${key}`, fullName: `Exam ${key}`, email, mobile: mobile(), ...extra },
  });
  emails[key] = email;
  ids[key] = c.id;
  entries[key] = await enter(c.id, forRoundId);
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  roundId = (
    await makeExam('Exam Engine', { durationMinutes: 1, isOpen: true }, [
      { text: 'Describe a market.', maxMarks: 10, guidance: GUIDE },
      { text: 'Explain risk.', maxMarks: 15, guidance: GUIDE },
      { text: 'Retired question.', maxMarks: 5, active: false },
    ])
  ).roundId;
  closedRoundId = (await makeExam('Exam Closed', { durationMinutes: 1, isOpen: false })).roundId;
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) await makeCandidate(key, roundId);
  await makeCandidate('exempt', roundId, { locationExempt: true });
  await makeCandidate('closed', closedRoundId);
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

const startBody = (key: string, location: Record<string, unknown> = HERE) => ({ roundEntryId: entries[key], location });

async function start(key: string): Promise<StateBody> {
  const agent = await signIn(key);
  const res = await agent.post('/api/candidate/exam/start').send(startBody(key));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data as StateBody;
}

const entryStatus = async (entryId: string) => (await prisma.roundEntry.findUniqueOrThrow({ where: { id: entryId } })).status;

const save = (key: string, aqId: string, body: Record<string, unknown>) =>
  agents[key]!.put(`/api/candidate/exam/answers/${aqId}`).send({ typedChars: 0, intervalMs: 0, ...body });

let stateA: StateBody;

test('start without a granted location is LOCATION_REQUIRED, and the EXAM_START row is still written', async () => {
  const agent = await signIn('a');
  const res = await agent.post('/api/candidate/exam/start').send(startBody('a', { stage: 'EXAM_START', permission: 'DENIED' }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'LOCATION_REQUIRED');
  const rows = await prisma.candidateLoginLog.findMany({ where: { candidateId: ids.a, stage: 'EXAM_START' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.permission, 'DENIED');
  assert.equal(await prisma.examAttempt.count({ where: { candidateId: ids.a } }), 0);
});

test('the first start sets questionsLocked', async () => {
  const before = await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } });
  assert.equal(before.questionsLocked, false);
  stateA = await start('a');
  const afterStart = await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } });
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
  assert.equal(await entryStatus(entries.a!), 'IN_PROGRESS');
  const cand = await prisma.candidate.findUniqueOrThrow({ where: { id: ids.a } });
  assert.equal(cand.status, 'NOT_STARTED', 'candidates.status is no longer written');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { candidateId: ids.a } });
  assert.deepEqual(hist.map((h) => [h.roundEntryId, h.fromStatus, h.toStatus]), [[entries.a, 'NOT_STARTED', 'IN_PROGRESS']]);
  const attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id: stateA.attemptId } });
  assert.equal(attempt.roundEntryId, entries.a);
  assert.equal(attempt.candidateId, ids.a);
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
  await prisma.roundEntry.update({ where: { id: entries.f }, data: { status: 'NOT_STARTED' } });
  const fresh = await start('f');
  assert.notEqual(fresh.attemptId, old.id);
  assert.equal(await autoSubmitAttempt(old.id), false);
  await sweepExpiredAttempts();
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: old.id } })).status, 'RESET');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: fresh.attemptId } })).status, 'IN_PROGRESS');
  assert.equal((await prisma.examAttempt.findUniqueOrThrow({ where: { id: fresh.attemptId } })).roundEntryId, entries.f);
  assert.equal(await entryStatus(entries.f!), 'IN_PROGRESS');
});

test('sweep auto-submits expired in-progress attempts', async () => {
  const attempt = await prisma.examAttempt.findFirstOrThrow({ where: { candidateId: ids.c, status: 'IN_PROGRESS' } });
  await prisma.examAttempt.update({ where: { id: attempt.id }, data: { endsAt: new Date(Date.now() - 20_000) } });
  await sweepExpiredAttempts();
  const done = await prisma.examAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(done.status, 'AUTO_SUBMITTED');
  assert.equal(done.submitType, 'AUTO');
  assert.ok(done.submittedAt);
  assert.equal(await entryStatus(entries.c!), 'AUTO_SUBMITTED');
  const hist = await prisma.candidateStatusHistory.findMany({ where: { roundEntryId: entries.c }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(hist.map((h) => [h.candidateId, h.fromStatus, h.toStatus]), [
    [ids.c, 'NOT_STARTED', 'IN_PROGRESS'],
    [ids.c, 'IN_PROGRESS', 'AUTO_SUBMITTED'],
  ]);
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
  assert.equal(await entryStatus(entries.b!), 'SUBMITTED');
  assert.equal(await getAutoSubmitQueue().getJob(`attempt-${stateB.attemptId}`), undefined);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: stateB.attemptId, eventType: 'EXAM_SUBMITTED' } }), 1);
  const late = await save('b', stateB.questions[0]!.attemptQuestionId, { sessionId: stateB.sessionId, clientSeq: 1, text: 'after submit' });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ATTEMPT_LOCKED');
  const resubmit = await agents.b!.post('/api/candidate/exam/submit').send({ sessionId: stateB.sessionId });
  assert.equal(resubmit.status, 409);
  assert.equal(resubmit.body.error.code, 'ATTEMPT_LOCKED');
  const again = await agents.b!.post('/api/candidate/exam/start').send(startBody('b'));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
  const state = await agents.b!.get('/api/candidate/exam');
  assert.equal(state.body.data.status, 'SUBMITTED');
});

test('a location-exempt candidate starts without a location; a closed round is EXAM_NOT_OPEN', async () => {
  const exempt = await (await signIn('exempt')).post('/api/candidate/exam/start').send(startBody('exempt', { stage: 'EXAM_START', permission: 'DENIED' }));
  assert.equal(exempt.status, 200, JSON.stringify(exempt.body));
  const closed = await (await signIn('closed')).post('/api/candidate/exam/start').send(startBody('closed'));
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
  await makeCandidate('sup', roundId);
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

test('100 concurrent starts for one round all succeed, and saves keep working meanwhile', async () => {
  const burst = await makeExam('Exam Burst', { durationMinutes: 30, isOpen: true }, [{ text: 'Burst one.' }, { text: 'Burst two.' }]);
  const created = await prisma.candidate.createManyAndReturn({
    data: Array.from({ length: 101 }, (_, i) => ({
      candidateCode: `B-${RUN}-${i}`,
      fullName: `Burst ${i}`,
      email: `burst${i}-${RUN}@exam.int.test`,
      mobile: mobile(),
    })),
    select: { id: true },
  });
  const burstEntries = new Map<string, string>();
  for (const c of created) burstEntries.set(c.id, await enter(c.id, burst.roundId));
  const [early, ...rest] = created;
  const earlyCookie = await mintCookies(early!.id);
  const earlyBody = { roundEntryId: burstEntries.get(early!.id), location: HERE };
  const earlyStart = await request(app).post('/api/candidate/exam/start').set('Cookie', earlyCookie).send(earlyBody);
  assert.equal(earlyStart.status, 200, JSON.stringify(earlyStart.body));
  const earlyState = earlyStart.body.data as StateBody;
  const cookies = await Promise.all(rest.map(async (c) => ({ cookie: await mintCookies(c.id), entryId: burstEntries.get(c.id) })));

  const starts = cookies.map(({ cookie, entryId }) =>
    request(app).post('/api/candidate/exam/start').set('Cookie', cookie).send({ roundEntryId: entryId, location: HERE }),
  );
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
  assert.equal(await prisma.examAttempt.count({ where: { roundEntry: { roundId: burst.roundId } } }), 101);
  assert.equal((await prisma.examRound.findUniqueOrThrow({ where: { id: burst.roundId } })).questionsLocked, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: earlyState.questions[0]!.attemptQuestionId } })).clientSeq, 20);

  // Ruling: an already-submitted attempt is ALREADY_ATTEMPTED even once the round has closed.
  const submit = await request(app).post('/api/candidate/exam/submit').set('Cookie', earlyCookie).send({ sessionId: (await request(app).post('/api/candidate/exam/resume').set('Cookie', earlyCookie)).body.data.sessionId });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  await prisma.examRound.update({ where: { id: burst.roundId }, data: { isOpen: false } });
  const again = await request(app).post('/api/candidate/exam/start').set('Cookie', earlyCookie).send(earlyBody);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, 'ALREADY_ATTEMPTED');
});

// ---- final review fixes ---------------------------------------------------

test('I1: a repeated start of a running attempt resumes it after windowEnd and without a location', async () => {
  const late = await makeExam('Exam Late', { durationMinutes: 30, isOpen: true });
  await makeCandidate('late', late.roundId);
  const first = await start('late');
  // The window closes while the candidate is mid-exam (they keep their full duration).
  await prisma.examRound.update({ where: { id: late.roundId }, data: { windowEnd: new Date(Date.now() - 60_000) } });
  const afterWindow = await agents.late!.post('/api/candidate/exam/start').send(startBody('late'));
  assert.equal(afterWindow.status, 200, JSON.stringify(afterWindow.body));
  assert.equal(afterWindow.body.data.attemptId, first.attemptId);
  assert.equal(afterWindow.body.data.endsAt, first.endsAt);
  assert.notEqual(afterWindow.body.data.sessionId, first.sessionId);
  // Location since switched off: still a resume, not LOCATION_REQUIRED.
  const noLocation = await agents.late!.post('/api/candidate/exam/start').send(startBody('late', { stage: 'EXAM_START', permission: 'DENIED' }));
  assert.equal(noLocation.status, 200, JSON.stringify(noLocation.body));
  assert.equal(noLocation.body.data.attemptId, first.attemptId);
  // A candidate who never started still meets the closed window.
  await makeCandidate('latenew', late.roundId);
  const fresh = await (await signIn('latenew')).post('/api/candidate/exam/start').send(startBody('latenew'));
  assert.equal(fresh.status, 403);
  assert.equal(fresh.body.error.code, 'EXAM_WINDOW_CLOSED');
});

test('I4: an Undo re-insertion sent as restoredChars is saved without a SUSPICIOUS_BULK_INSERT flag', async () => {
  const undo = await makeExam('Exam Undo', { durationMinutes: 30, isOpen: true });
  await makeCandidate('undo', undo.roundId);
  const st = await start('undo');
  const aq = st.questions[0]!.attemptQuestionId;
  const res = await save('undo', aq, { sessionId: st.sessionId, clientSeq: 1, text: 'y'.repeat(400), typedChars: 0, restoredChars: 400, intervalMs: 2000 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal((await prisma.answer.findUniqueOrThrow({ where: { attemptQuestionId: aq } })).bulkInsertFlags, 0);
  assert.equal(await prisma.activityLog.count({ where: { attemptId: st.attemptId, eventType: 'SUSPICIOUS_BULK_INSERT' } }), 0);
});

// ---- rounds: one exam at a time, start by round entry ---------------------

async function addRound(examId: string, roundNumber: number, round: RoundSeed = {}) {
  const r = await prisma.examRound.create({ data: { examId, roundNumber, durationMinutes: 30, isOpen: true, ...round } });
  await prisma.question.create({ data: { roundId: r.id, text: `Round ${roundNumber} one.`, normalizedTextHash: `r${roundNumber}-${examId}`, maxMarks: 10 } });
  return r.id;
}

const multi = { cookie: '', p: { examName: '', entryId: '' }, q: { examName: '', entryId: '' } };

test('concurrent starts across rounds: one 200, the other 409 EXAM_IN_PROGRESS, one IN_PROGRESS attempt', async () => {
  const p = await makeExam('Multi P', { durationMinutes: 30 });
  const q = await makeExam('Multi Q', { durationMinutes: 30 });
  await makeCandidate('multi', p.roundId);
  multi.p = { examName: p.examName, entryId: entries.multi! };
  multi.q = { examName: q.examName, entryId: await enter(ids.multi!, q.roundId) };
  multi.cookie = await mintCookies(ids.multi!);
  const go = (entryId: string) => request(app).post('/api/candidate/exam/start').set('Cookie', multi.cookie).send({ roundEntryId: entryId, location: HERE });
  const [rp, rq] = await Promise.all([go(multi.p.entryId), go(multi.q.entryId)]);
  assert.deepEqual([rp.status, rq.status].sort(), [200, 409], `${JSON.stringify(rp.body)} ${JSON.stringify(rq.body)}`);
  const [won, lost, wonExam] = rp.status === 200 ? [rp, rq, multi.p] : [rq, rp, multi.q];
  assert.equal(lost.body.error.code, 'EXAM_IN_PROGRESS');
  assert.equal(lost.body.error.message, `Finish your current exam first ("${wonExam.examName} · Round 1").`);
  const live = await prisma.examAttempt.findMany({ where: { candidateId: ids.multi, status: 'IN_PROGRESS' } });
  assert.equal(live.length, 1);
  assert.equal(live[0]?.id, won.body.data.attemptId);
  assert.equal(live[0]?.roundEntryId, wonExam.entryId);
  // A repeated start of the running round is still a takeover, not a 409.
  const repeat = await go(wonExam.entryId);
  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  assert.equal(repeat.body.data.attemptId, won.body.data.attemptId);
  if (wonExam === multi.q) [multi.p, multi.q] = [multi.q, multi.p];
});

test("start someone else's entry, an unknown id or a round without an entry is 404 Exam not found.", async () => {
  const agent = await signIn('e');
  const nextRound = await addRound((await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } })).examId, 2);
  for (const roundEntryId of [entries.closed, crypto.randomUUID(), nextRound]) {
    const res = await agent.post('/api/candidate/exam/start').send({ roundEntryId, location: HERE });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(res.body.error.message, 'Exam not found.');
  }
  assert.equal(await prisma.examAttempt.count({ where: { roundEntryId: entries.closed } }), 0);
});

test('after submit, the second exam starts', async () => {
  // multi.p now holds the running round (swapped by the concurrency test).
  const resumed = await request(app).post('/api/candidate/exam/resume').set('Cookie', multi.cookie);
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const submitted = await request(app).post('/api/candidate/exam/submit').set('Cookie', multi.cookie).send({ sessionId: resumed.body.data.sessionId });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const second = await request(app).post('/api/candidate/exam/start').set('Cookie', multi.cookie).send({ roundEntryId: multi.q.entryId, location: HERE });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(await entryStatus(multi.p.entryId), 'SUBMITTED');
  assert.equal(await entryStatus(multi.q.entryId), 'IN_PROGRESS');
  // GET /exam follows the running attempt; any other start now waits for it to finish.
  const state = await request(app).get('/api/candidate/exam').set('Cookie', multi.cookie);
  assert.equal(state.body.data.attemptId, second.body.data.attemptId);
  const first = await request(app).post('/api/candidate/exam/start').set('Cookie', multi.cookie).send({ roundEntryId: multi.p.entryId, location: HERE });
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'EXAM_IN_PROGRESS');
});

test('deactivated exam lets the running attempt finish; a new start in it is EXAM_NOT_OPEN', async () => {
  const d = await makeExam('Exam Deact', { durationMinutes: 30 });
  await makeCandidate('deact', d.roundId);
  await makeCandidate('deact2', d.roundId);
  const st = await start('deact');
  await prisma.exam.update({ where: { id: d.examId }, data: { active: false } });
  const cards = await agents.deact!.get('/api/candidate/exams');
  assert.deepEqual(
    (cards.body.data as { entryId: string; state: string }[]).map((c) => [c.entryId, c.state]),
    [[entries.deact, 'IN_PROGRESS']],
    'the running round stays visible so it can be resumed',
  );
  const saved = await save('deact', st.questions[0]!.attemptQuestionId, { sessionId: st.sessionId, clientSeq: 1, text: 'still going', typedChars: 11, intervalMs: 3000 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const submitted = await agents.deact!.post('/api/candidate/exam/submit').send({ sessionId: st.sessionId });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const blocked = await (await signIn('deact2')).post('/api/candidate/exam/start').send(startBody('deact2'));
  assert.equal(blocked.status, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.error.code, 'EXAM_NOT_OPEN');
  assert.deepEqual((await agents.deact2!.get('/api/candidate/exams')).body.data, [], 'inactive exams are hidden');
});

interface Card {
  entryId: string;
  jobRoleName: string;
  examName: string;
  roundNumber: number;
  roundName: string;
  durationMinutes: number;
  windowStart: string | null;
  windowEnd: string | null;
  instructions: string;
  state: string;
}

test('GET /candidate/exams: READY, NOT_OPEN, BEFORE_WINDOW, CLOSED, IN_PROGRESS, BLOCKED_OTHER_IN_PROGRESS, SUBMITTED; no card for an unentered round', async () => {
  assert.equal((await request(app).get('/api/candidate/exams')).status, 401);
  const soon = new Date(Date.now() + 3_600_000);
  const a = await makeExam('Cards A', { durationMinutes: 45, instructions: 'Read A.' });
  const b = await makeExam('Cards B', { windowStart: soon });
  const c = await makeExam('Cards C', { isOpen: false });
  const d = await makeExam('Cards D', { windowEnd: new Date(Date.now() - 60_000) });
  const off = await makeExam('Cards Off');
  await prisma.exam.update({ where: { id: off.examId }, data: { active: false } });
  await addRound(b.examId, 2);
  await makeCandidate('cards', a.roundId);
  const entryB = await enter(ids.cards!, b.roundId);
  const entryC = await enter(ids.cards!, c.roundId);
  const entryD = await enter(ids.cards!, d.roundId);
  await enter(ids.cards!, off.roundId);
  const agent = await signIn('cards');
  const cards = async () => ((await agent.get('/api/candidate/exams')).body.data as Card[]).map((x) => [x.examName, x.roundNumber, x.state]);

  const first = (await agent.get('/api/candidate/exams')).body.data as Card[];
  assert.deepEqual(first[0], {
    entryId: entries.cards,
    jobRoleName: `Cards A Profile ${RUN}`,
    examName: a.examName,
    roundNumber: 1,
    roundName: '',
    durationMinutes: 45,
    windowStart: null,
    windowEnd: null,
    instructions: 'Read A.',
    state: 'READY',
  });
  assert.equal(first[1]?.entryId, entryB);
  assert.equal(first[1]?.windowStart, soon.toISOString());
  assert.deepEqual(first.map((x) => x.entryId), [entries.cards, entryB, entryC, entryD]);
  assert.deepEqual(await cards(), [
    [a.examName, 1, 'READY'],
    [b.examName, 1, 'BEFORE_WINDOW'],
    [c.examName, 1, 'NOT_OPEN'],
    [d.examName, 1, 'CLOSED'],
  ]);

  const st = await start('cards');
  assert.deepEqual(await cards(), [
    [a.examName, 1, 'IN_PROGRESS'],
    [b.examName, 1, 'BLOCKED_OTHER_IN_PROGRESS'],
    [c.examName, 1, 'BLOCKED_OTHER_IN_PROGRESS'],
    [d.examName, 1, 'BLOCKED_OTHER_IN_PROGRESS'],
  ]);

  assert.equal((await agent.post('/api/candidate/exam/submit').send({ sessionId: st.sessionId })).status, 200);
  assert.deepEqual(await cards(), [
    [a.examName, 1, 'SUBMITTED'],
    [b.examName, 1, 'BEFORE_WINDOW'],
    [c.examName, 1, 'NOT_OPEN'],
    [d.examName, 1, 'CLOSED'],
  ]);
});

test('a unique violation on the one-in-progress index is recognised as EXAM_IN_PROGRESS', async () => {
  const x = await makeExam('Idx X', { durationMinutes: 30 });
  const y = await makeExam('Idx Y', { durationMinutes: 30 });
  await makeCandidate('idx', x.roundId);
  const entryY = await enter(ids.idx!, y.roundId);
  const row = (roundEntryId: string) => ({
    candidateId: ids.idx!,
    roundEntryId,
    status: 'IN_PROGRESS' as const,
    startedAt: new Date(),
    endsAt: new Date(Date.now() + 60_000),
    activeSessionId: crypto.randomUUID(),
    startIp: '127.0.0.1',
    userAgent: 'test',
    maxMarks: 10,
  });
  await prisma.examAttempt.create({ data: row(entries.idx!) });
  const err = await prisma.examAttempt.create({ data: row(entryY) }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err, 'the index refuses a second IN_PROGRESS attempt');
  assert.equal(isCandidateInProgressViolation(err), true);
  assert.equal(isCandidateInProgressViolation(new Error('other')), false);
});
