// Questions end to end against exam_test: CRUD, import preview/confirm with the
// duplicate-file guard, the lock (423) and its Super Admin-only unlock, and
// copying questions between rounds. Questions belong to a round (spec 2026-11-10).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Express } from 'express';
import { env } from '../../src/infrastructure/config/env.js';
import { prisma } from '../../src/infrastructure/db/prisma.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { createApp } from '../../src/app.js';

const SA = { email: 'super@questions.test', password: 'super-pass-123' };
const SA2 = { email: 'super2@questions.test', password: 'super-pass-456' };
const EV = { email: 'eval@questions.test', password: 'eval-pass-123' };
let app: Express;
let sa: request.Agent;
let sa2: request.Agent;
let ev: request.Agent;
let roundId = '';
let round2Id = '';

async function signIn(creds: { email: string; password: string }) {
  const stale = [...(await getRedis().keys('exam:otp:cd:admin_login:*')), ...(await getRedis().keys('exam:rl:*'))];
  if (stale.length > 0) await getRedis().del(...stale);
  const agent = request.agent(app);
  const login = await agent.post('/api/admin/auth/login').send(creds);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const verify = await agent
    .post('/api/admin/auth/verify-otp')
    .send({ challengeId: login.body.data.challengeId, code: '123456' });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return agent;
}

before(async () => {
  assert.match(env.DATABASE_URL, /\/exam_test(\?|$)/);
  assert.match(env.REDIS_URL, /\/15$/);
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE admin_audit_logs, import_batches, questions, drives, exam_rounds, job_roles, admin_users RESTART IDENTITY CASCADE',
  );
  await getRedis().flushdb();
  for (const [c, name, role] of [
    [SA, 'Q Super', 'SUPER_ADMIN'],
    [SA2, 'Q Super Two', 'SUPER_ADMIN'],
    [EV, 'Q Eval', 'EVALUATOR'],
  ] as const) {
    await prisma.adminUser.create({
      data: { email: c.email, name, role, passwordHash: await bcrypt.hash(c.password, 4) },
    });
  }
  roundId = (await prisma.jobRole.create({ data: { name: 'Q Role', rounds: { create: { roundNumber: 1 } } }, include: { rounds: true } })).rounds[0]!.id;
  round2Id = (await prisma.jobRole.create({ data: { name: 'Q Role Two', rounds: { create: { roundNumber: 1 } } }, include: { rounds: true } })).rounds[0]!.id;
  app = createApp();
  sa = await signIn(SA);
  sa2 = await signIn(SA2);
  ev = await signIn(EV);
});

after(async () => {
  await prisma.$disconnect();
  await getRedis().quit();
});

const csv = (rows: string[]) =>
  Buffer.from(['question_text,max_marks,evaluator_guidance,display_order', ...rows].join('\n'));

const preview = (agent: request.Agent, file: Buffer, roundId: string, name = 'q.csv') =>
  agent.post('/api/admin/questions/import/preview').field('roundId', roundId).attach('file', file, name);

test('template.csv is served with the type, text, marks, guidance, order and MCQ columns', async () => {
  const res = await sa.get('/api/admin/questions/template.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/csv/);
  assert.match(res.text, /^type,question_text,max_marks,evaluator_guidance,display_order,option_a,option_b,option_c,option_d,correct_option/);
});

test('sample.csv is served as a CSV attachment', async () => {
  const res = await sa.get('/api/admin/questions/sample.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/csv/);
  assert.match(res.headers['content-disposition'] ?? '', /questions-sample\.csv/);
  assert.match(res.text, /^type,question_text,max_marks,evaluator_guidance,display_order,option_a,option_b,option_c,option_d,correct_option\n/);
});

test('import: preview then confirm inserts N rows; the same file again is 409 until forced', async () => {
  const file = csv([
    'Explain the CAP theorem with an example,10,Look for partition tolerance,',
    'Describe how an index speeds up a query,5,,',
    'bad row text here,7.3,,',
    'explain THE cap theorem with an example,10,,',
  ]);
  const p = await preview(sa, file, roundId);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.data.summary, { total: 4, valid: 2, errors: 1, duplicates: 1 });
  assert.equal(p.body.data.errors[0].field, 'max_marks');
  assert.deepEqual(p.body.data.duplicates, [{ row: 5, reason: 'IN_FILE' }]);
  assert.equal(p.body.data.valid[1].displayOrder, 2);
  assert.ok(await getRedis().get(`exam:import:${p.body.data.previewId}`));

  assert.equal((await ev.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId })).status, 403);
  assert.equal((await sa2.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId })).status, 403);

  const c = await sa.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(c.body.data, { imported: 2, skipped: 2 });
  assert.equal(await prisma.question.count({ where: { roundId: roundId } }), 2);
  assert.equal(await prisma.importBatch.count({ where: { kind: 'QUESTIONS', roundId: roundId } }), 1);

  const again = await preview(sa, file, roundId);
  assert.equal(again.body.data.summary.valid, 0);
  assert.equal(again.body.data.summary.duplicates, 3);
  const conflict = await sa.post('/api/admin/questions/import/confirm').send({ previewId: again.body.data.previewId });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'CONFLICT');
  assert.match(conflict.body.error.message, /^This file was already imported on /);

  const forced = await sa
    .post('/api/admin/questions/import/confirm')
    .send({ previewId: again.body.data.previewId, force: true });
  assert.equal(forced.status, 200, JSON.stringify(forced.body));
  assert.deepEqual(forced.body.data, { imported: 0, skipped: 4 });
  assert.equal(await prisma.question.count({ where: { roundId: roundId } }), 2);
});

test('import: missing required column, bad extension and unknown preview', async () => {
  const noCol = await preview(sa, Buffer.from('question_text\nsome long enough text\n'), roundId);
  assert.equal(noCol.status, 400);
  const pdf = await preview(sa, Buffer.from('x'), roundId, 'q.pdf');
  assert.equal(pdf.status, 400);
  const gone = await sa.post('/api/admin/questions/import/confirm').send({ previewId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(gone.status, 404);
  assert.equal((await ev.post('/api/admin/questions/import/preview').field('roundId', roundId)).status, 403);
});

test('list returns the paged envelope with guidance for Evaluators too', async () => {
  const res = await ev.get(`/api/admin/questions?roundId=${roundId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2);
  assert.equal(res.body.data.page, 1);
  assert.equal(res.body.data.items[0].questionText, 'Explain the CAP theorem with an example');
  assert.equal(res.body.data.items[0].evaluatorGuidance, 'Look for partition tolerance');
  assert.equal(res.body.data.items[0].maxMarks, 10);
  assert.equal((await ev.get('/api/admin/questions')).status, 400);
});

test('create, duplicate 409, patch, deactivate and reorder', async () => {
  const body = { roundId: round2Id, questionText: 'What is idempotency in HTTP?', maxMarks: 4, evaluatorGuidance: null };
  assert.equal((await ev.post('/api/admin/questions').send(body)).status, 403);
  const a = await sa.post('/api/admin/questions').send(body);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.data.displayOrder, 1);
  const dup = await sa.post('/api/admin/questions').send({ ...body, questionText: '  what is IDEMPOTENCY in http? ' });
  assert.equal(dup.status, 409);
  const b = await sa.post('/api/admin/questions').send({ ...body, questionText: 'Explain database transactions' });
  assert.equal(b.body.data.displayOrder, 2);

  const patched = await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ maxMarks: 6.5, questionText: 'What is idempotency in REST?' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.maxMarks, 6.5);
  assert.equal((await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ maxMarks: 7.3 })).status, 400);
  const clash = await sa.patch(`/api/admin/questions/${a.body.data.id}`).send({ questionText: 'explain database transactions' });
  assert.equal(clash.status, 409);

  const off = await sa.patch(`/api/admin/questions/${b.body.data.id}/active`).send({ active: false });
  assert.equal(off.body.data.active, false);

  const order = await sa
    .patch(`/api/admin/rounds/${round2Id}/questions/order`)
    .send({ ids: [b.body.data.id, a.body.data.id] });
  assert.equal(order.status, 200, JSON.stringify(order.body));
  const rows = await prisma.question.findMany({ where: { roundId: round2Id }, orderBy: { displayOrder: 'asc' } });
  assert.deepEqual(rows.map((r) => r.id), [b.body.data.id, a.body.data.id]);
  const foreign = await sa.patch(`/api/admin/rounds/${round2Id}/questions/order`).send({ ids: [b.body.data.id, (await prisma.question.findFirstOrThrow({ where: { roundId: roundId } })).id] });
  assert.equal(foreign.status, 400);
});

test('locked round: every write is 423; unlock needs Super Admin, is audited, and re-opens writes', async () => {
  const q = await prisma.question.findFirstOrThrow({ where: { roundId: roundId } });
  await prisma.examRound.update({ where: { id: roundId }, data: { questionsLocked: true } });

  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).status, 423);
  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).body.error.code, 'QUESTIONS_LOCKED');
  assert.equal((await sa.patch(`/api/admin/questions/${q.id}/active`).send({ active: false })).status, 423);
  assert.equal(
    (await sa.post('/api/admin/questions').send({ roundId: roundId, questionText: 'A brand new locked question', maxMarks: 5 })).status,
    423,
  );
  assert.equal((await sa.patch(`/api/admin/rounds/${roundId}/questions/order`).send({ ids: [q.id] })).status, 423);
  assert.equal((await preview(sa, csv(['Another question for locked role,5,,']), roundId)).status, 423);

  assert.equal((await ev.post(`/api/admin/rounds/${roundId}/questions/unlock`).send({ reason: 'Fix a typo' })).status, 403);
  assert.equal((await sa.post(`/api/admin/rounds/${roundId}/questions/unlock`).send({})).status, 400);
  const un = await sa.post(`/api/admin/rounds/${roundId}/questions/unlock`).send({ reason: 'Fix a typo' });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.data.questionsLocked, false);
  assert.equal((await prisma.examRound.findUniqueOrThrow({ where: { id: roundId } })).questionsLocked, false);

  const log = await prisma.adminAuditLog.findFirst({ where: { action: 'QUESTIONS_UNLOCKED' } });
  assert.equal(log?.entityId, roundId);
  assert.equal((log?.metadata as { reason?: string }).reason, 'Fix a typo');

  assert.equal((await sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 3 })).status, 200);
});

test('a lock set in a concurrent transaction makes the waiting write 423 (row lock)', async () => {
  const q = await prisma.question.findFirstOrThrow({ where: { roundId: roundId } });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const starter = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM exam_rounds WHERE id = ${roundId}::uuid FOR UPDATE`;
    await tx.examRound.update({ where: { id: roundId }, data: { questionsLocked: true } });
    locked();
    await held;
  });
  await ready;
  const write = sa.patch(`/api/admin/questions/${q.id}`).send({ maxMarks: 2 }).then((r) => r);
  await new Promise((r) => setTimeout(r, 300));
  release();
  await starter;
  const res = await write;
  assert.equal(res.status, 423, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'QUESTIONS_LOCKED');
  await prisma.examRound.update({ where: { id: roundId }, data: { questionsLocked: false } });
});

// ---- copy questions from another round (spec 2026-11-10 §5.1) -------------------

async function newRound(name: string): Promise<string> {
  return (await prisma.jobRole.create({ data: { name, rounds: { create: { roundNumber: 1 } } }, include: { rounds: true } })).rounds[0]!.id;
}

test('copy into empty round copies active questions in order', async () => {
  const from = await newRound('Copy Source');
  await prisma.question.createMany({
    data: [
      { roundId: from, text: 'Second', normalizedTextHash: 'c2', maxMarks: 5, displayOrder: 2, evaluatorGuidance: 'g2' },
      { roundId: from, text: 'First', normalizedTextHash: 'c1', maxMarks: 10, displayOrder: 1 },
      { roundId: from, text: 'Inactive', normalizedTextHash: 'c3', maxMarks: 1, displayOrder: 3, active: false },
    ],
  });
  const to = await newRound('Copy Target (Internship)');
  assert.equal((await ev.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from })).status, 403);
  const res = await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { copied: 2, skippedDuplicates: 0 });
  const rows = await prisma.question.findMany({ where: { roundId: to }, orderBy: { displayOrder: 'asc' } });
  assert.deepEqual(
    rows.map((r) => [r.text, Number(r.maxMarks), r.evaluatorGuidance, r.displayOrder, r.active]),
    [['First', 10, null, 1, true], ['Second', 5, 'g2', 2, true]],
  );
  assert.equal(await prisma.adminAuditLog.count({ where: { action: 'QUESTIONS_COPIED', entityId: to } }), 1);
  assert.equal(await prisma.question.count({ where: { roundId: from } }), 3, 'source untouched');
});

test('copy into round with questions without replace → 409; with replace deactivates the old ones', async () => {
  const from = await newRound('Copy Source 2');
  await prisma.question.create({ data: { roundId: from, text: 'New one', normalizedTextHash: 'n1', maxMarks: 4, displayOrder: 1 } });
  const to = await newRound('Copy Target 2');
  await prisma.question.create({ data: { roundId: to, text: 'Old one', normalizedTextHash: 'o1', maxMarks: 4, displayOrder: 1 } });
  const refused = await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'TARGET_HAS_QUESTIONS');
  const res = await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from, replace: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.copied, 1);
  const rows = await prisma.question.findMany({ where: { roundId: to }, orderBy: { text: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.text, r.active]), [['New one', true], ['Old one', false]]);
});

test('copy into locked round → 423 QUESTIONS_LOCKED; copy from itself or unknown → 400/404', async () => {
  const from = await newRound('Copy Source 3');
  const to = await newRound('Copy Target 3');
  await prisma.examRound.update({ where: { id: to }, data: { questionsLocked: true } });
  const res = await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from });
  assert.equal(res.status, 423);
  assert.equal(res.body.error.code, 'QUESTIONS_LOCKED');
  assert.equal((await sa.post(`/api/admin/rounds/${from}/questions/copy`).send({ fromRoundId: from })).status, 400);
  assert.equal((await sa.post(`/api/admin/rounds/${from}/questions/copy`).send({ fromRoundId: '00000000-0000-4000-8000-000000000000' })).status, 404);
});

test('copy with replace over the same text re-activates and refreshes those questions instead of leaving them inactive', async () => {
  const from = await newRound('Refresh Source');
  await prisma.question.createMany({
    data: [
      { roundId: from, text: 'Shared question', normalizedTextHash: 'shared-1', maxMarks: 8, displayOrder: 1, evaluatorGuidance: 'new guide' },
      { roundId: from, text: 'Brand new question', normalizedTextHash: 'fresh-1', maxMarks: 4, displayOrder: 2 },
    ],
  });
  const to = await newRound('Refresh Target');
  await prisma.question.createMany({
    data: [
      { roundId: to, text: 'Shared question', normalizedTextHash: 'shared-1', maxMarks: 5, displayOrder: 7 },
      { roundId: to, text: 'Only in target', normalizedTextHash: 'only-1', maxMarks: 3, displayOrder: 8 },
    ],
  });
  const res = await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from, replace: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { copied: 2, skippedDuplicates: 0 });
  const rows = await prisma.question.findMany({ where: { roundId: to }, orderBy: { text: 'asc' } });
  assert.deepEqual(
    rows.map((r) => [r.text, r.active, Number(r.maxMarks), r.evaluatorGuidance]),
    [['Brand new question', true, 4, null], ['Only in target', false, 3, null], ['Shared question', true, 8, 'new guide']],
  );
  const active = rows.filter((r) => r.active).sort((a, b) => a.displayOrder - b.displayOrder).map((r) => r.text);
  assert.deepEqual(active, ['Shared question', 'Brand new question'], 'source order kept');
});

// ---- MCQ questions (spec 2026-11-10) ------------------------------------------------

test('create/edit MCQ and list shows options + correct; written and MCQ rules enforced', async () => {
  const round = await newRound('MCQ Round');
  const body = { roundId: round, type: 'MCQ', questionText: 'Which HTTP method is idempotent?', maxMarks: 1, options: ['POST', 'PATCH', 'PUT', 'CONNECT'], correctOption: 2 };
  const created = await sa.post('/api/admin/questions').send(body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.data.type, created.body.data.options, created.body.data.correctOption], ['MCQ', ['POST', 'PATCH', 'PUT', 'CONNECT'], 2]);
  // Same wording, different options: not a duplicate. Same wording + options: duplicate.
  assert.equal((await sa.post('/api/admin/questions').send({ ...body, options: ['GET', 'POST', 'PATCH', 'TRACE'], correctOption: 0 })).status, 201);
  assert.equal((await sa.post('/api/admin/questions').send(body)).status, 409);
  assert.equal((await sa.post('/api/admin/questions').send({ ...body, options: ['a', 'b', 'c'] })).status, 400);
  const edit = await sa.patch(`/api/admin/questions/${created.body.data.id}`).send({ options: ['POST', 'PATCH', 'PUT', 'DELETE'], correctOption: 3 });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual([edit.body.data.options[3], edit.body.data.correctOption], ['DELETE', 3]);
  const written = await sa.post('/api/admin/questions').send({ roundId: round, questionText: 'Explain idempotency in HTTP APIs.', maxMarks: 5 });
  assert.equal(written.status, 201);
  assert.equal(written.body.data.type, 'WRITTEN');
  assert.equal((await sa.patch(`/api/admin/questions/${written.body.data.id}`).send({ options: ['a', 'b', 'c', 'd'], correctOption: 0 })).status, 400);
  const list = await sa.get(`/api/admin/questions?roundId=${round}`);
  const mcqRow = list.body.data.items.find((q: { id: string }) => q.id === created.body.data.id);
  assert.deepEqual([mcqRow.type, mcqRow.correctOption], ['MCQ', 3]);
});

test('copy carries MCQ options and the correct option', async () => {
  const from = await newRound('MCQ Copy Source');
  await sa.post('/api/admin/questions').send({ roundId: from, type: 'MCQ', questionText: 'Which number is prime here?', maxMarks: 2, options: ['4', '6', '7', '9'], correctOption: 2 });
  const to = await newRound('MCQ Copy Target');
  assert.equal((await sa.post(`/api/admin/rounds/${to}/questions/copy`).send({ fromRoundId: from })).status, 200);
  const [q] = await prisma.question.findMany({ where: { roundId: to } });
  assert.deepEqual([q!.type, q!.options, q!.correctOption, Number(q!.maxMarks)], ['MCQ', ['4', '6', '7', '9'], 2, 2]);
});

test('MCQ import creates MCQs with options', async () => {
  const round = await newRound('MCQ Import');
  const file = Buffer.from(['type,question_text,max_marks,option_a,option_b,option_c,option_d,correct_option', 'MCQ,Which planet is largest?,1,Mars,Jupiter,Venus,Earth,B'].join('\n'));
  const p = await sa.post('/api/admin/questions/import/preview').field('roundId', round).attach('file', file, 'm.csv');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await sa.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId })).status, 200);
  const [q] = await prisma.question.findMany({ where: { roundId: round } });
  assert.deepEqual([q!.type, q!.options, q!.correctOption], ['MCQ', ['Mars', 'Jupiter', 'Venus', 'Earth'], 1]);
});

// ---- review I2: the negative-marking cap holds on every question write -------------

test('no question write can make an active MCQ worth less than the round negative marking', async () => {
  const r = await newRound('Cap Round');
  // No MCQs yet, so any value is accepted for the round.
  await prisma.examRound.update({ where: { id: r }, data: { mcqNegativeMarks: 1 } });
  const mcq = (text: string, maxMarks: number) => ({ roundId: r, type: 'MCQ', questionText: text, maxMarks, options: ['4', '6', '7', '9'], correctOption: 2 });
  const capped = (res: request.Response, label: string) => {
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error.message, /negative marking/i, label);
  };

  // create
  capped(await sa.post('/api/admin/questions').send(mcq('Pick the prime number', 0.5)), 'create');
  const ok = await sa.post('/api/admin/questions').send(mcq('Pick the prime number', 2));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // update marks below the negative
  capped(await sa.patch(`/api/admin/questions/${ok.body.data.id}`).send({ maxMarks: 0.5 }), 'update');
  // re-activating a small MCQ
  const small = await prisma.question.create({ data: { roundId: r, type: 'MCQ', text: 'Pick the even number', normalizedTextHash: `cap-s-${r}`, maxMarks: 0.5, options: ['3', '5', '8', '11'], correctOption: 2, active: false } });
  capped(await sa.patch(`/api/admin/questions/${small.id}/active`).send({ active: true }), 'setActive');
  // copy in a small MCQ from another round
  const from = await newRound('Cap Source');
  await prisma.question.create({ data: { roundId: from, type: 'MCQ', text: 'Pick the odd number', normalizedTextHash: `cap-c-${r}`, maxMarks: 0.5, options: ['2', '4', '5', '8'], correctOption: 2 } });
  capped(await sa.post(`/api/admin/rounds/${r}/questions/copy`).send({ fromRoundId: from, replace: true }), 'copy');
  // import a small MCQ
  const file = Buffer.from(['type,question_text,max_marks,evaluator_guidance,display_order,option_a,option_b,option_c,option_d,correct_option', 'MCQ,Pick the square number,0.5,,5,2,3,4,5,C'].join('\n'));
  const p = await preview(sa, file, r);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  capped(await sa.post('/api/admin/questions/import/confirm').send({ previewId: p.body.data.previewId }), 'import');

  // Nothing small got in; written questions are never capped.
  assert.equal(await prisma.question.count({ where: { roundId: r, type: 'MCQ', active: true, maxMarks: { lt: 1 } } }), 0);
  const w = await sa.post('/api/admin/questions').send({ roundId: r, questionText: 'Explain the CAP theorem briefly.', maxMarks: 0.5 });
  assert.equal(w.status, 201, JSON.stringify(w.body));
});
