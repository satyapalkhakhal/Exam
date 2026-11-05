import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailSendInput } from '@exam/shared';
import { createSystemConfigService, type SystemConfigRepository } from '../src/modules/systemConfig/systemConfig.service.js';
import {
  createDispatchProcessor,
  createEmailsService,
  type AuditEntry,
  type DispatchRepository,
  type EmailCandidate,
  type EmailsRepository,
  type NewDispatch,
  type QueuedDispatch,
} from '../src/modules/emails/emails.service.js';
import { DEFAULT_EMAIL_TEMPLATES } from '../src/modules/messaging/candidateEmails.js';
import { MessagingError } from '../src/modules/messaging/messaging.errors.js';
import { isChannelReady, type EmailConfig } from '../src/modules/messaging/messaging.config.js';
import { AppError } from '../src/shared/errors.js';

const READY: EmailConfig = { enabled: true, baseUrl: 'https://m.test', sendMailToken: 't', fromAddress: 'a@b.test', fromName: 'X', replyTo: '', ccAddresses: '' };
const ADMIN = '00000000-0000-4000-8000-0000000000aa';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const submitted = {
  status: 'SUBMITTED',
  startedAt: new Date('2026-11-03T07:40:00Z'),
  submittedAt: new Date('2026-11-03T08:35:00Z'),
  submitType: 'MANUAL' as const,
  answeredCount: 2,
  questionCount: 3,
  score: null as { total: number; max: number; percentage: number } | null,
};
const cand = (n: number, over: Partial<EmailCandidate> = {}): EmailCandidate => ({
  id: id(n),
  candidateCode: `ARC-000${n}`,
  fullName: `Person ${n}`,
  email: `p${n}@x.test`,
  eligible: true,
  status: 'SUBMITTED',
  result: null,
  jobRoleName: 'Backend Engineer',
  attempt: submitted,
  ...over,
});

function setup(opts: { candidates?: EmailCandidate[]; active?: string[]; email?: EmailConfig; enqueueFails?: boolean } = {}) {
  const rows = new Map<string, unknown>();
  const cfgRepo: SystemConfigRepository = {
    async findByKey(key) {
      return rows.has(key) ? { key, value: rows.get(key) } : null;
    },
    async upsert(key, value) {
      rows.set(key, value);
    },
  };
  const audits: AuditEntry[] = [];
  const created: NewDispatch[] = [];
  const enqueued: string[][] = [];
  const failed: { ids: string[]; error: string }[] = [];
  const sent: { to: string; subject: string }[] = [];
  const repo: EmailsRepository = {
    async templateMeta(keys) {
      return new Map(keys.filter((k) => rows.has(k)).map((k) => [k, { updatedAt: new Date('2026-11-03T00:00:00Z'), updatedByName: 'Sam' }]));
    },
    async firstActiveRoleName() {
      return 'Quant Analyst';
    },
    async adminEmail() {
      return 'admin@x.test';
    },
    async findCandidates(ids) {
      return (opts.candidates ?? []).filter((c) => ids.includes(c.id));
    },
    async candidateIdsWithActiveDispatch() {
      return new Set(opts.active ?? []);
    },
    async createDispatches(_batch, _by, list, audit) {
      created.push(...list);
      audits.push(audit);
      return list.map((_, i) => `d${i}`);
    },
    async failDispatches(ids, error) {
      failed.push({ ids, error });
    },
    async listDispatches() {
      return { items: [], total: 0 };
    },
  };
  const service = createEmailsService({
    repo,
    config: createSystemConfigService(cfgRepo),
    audit: async (e) => {
      audits.push(e);
    },
    getEmailConfig: async () => opts.email ?? READY,
    isChannelReady,
    sendEmail: async (p) => {
      sent.push({ to: p.to, subject: p.subject });
    },
    enqueue: async (ids) => {
      if (opts.enqueueFails) throw new Error('redis down');
      enqueued.push(ids);
    },
    newBatchId: () => 'batch-1',
  });
  return { service, rows, audits, created, enqueued, failed, sent };
}

const send = (over: Partial<EmailSendInput> & Pick<EmailSendInput, 'candidateIds'>): EmailSendInput => ({ template: 'SUBMISSION_RECEIVED', ...over });

// ---- templates --------------------------------------------------------------------

test('templates list as defaults until saved, then as custom with who saved them', async () => {
  const { service } = setup();
  const before = (await service.listTemplates()).templates;
  assert.deepEqual(before.map((t) => t.key), ['SUBMISSION_RECEIVED', 'SHORTLISTED', 'REJECTED']);
  assert.ok(before.every((t) => t.isDefault && t.updatedAt === null));
  assert.equal(before[0]!.subject, DEFAULT_EMAIL_TEMPLATES.SUBMISSION_RECEIVED.subject);
  assert.ok(before[0]!.placeholders.some((p) => p.token === '{submittedAt}'));

  const saved = await service.saveTemplate('SHORTLISTED', { subject: 'Hi {firstName}', body: 'Round {roundName}' }, ADMIN);
  assert.equal(saved.isDefault, false);
  assert.equal(saved.subject, 'Hi {firstName}');
  assert.equal(saved.updatedByName, 'Sam');
  assert.ok(saved.updatedAt);
});

test('save rejects an unknown placeholder, naming it, and writes nothing', async () => {
  const { service, rows, audits } = setup();
  await assert.rejects(
    service.saveTemplate('SUBMISSION_RECEIVED', { subject: 'Hi {firstName}', body: 'On {scheduledAt} {nope}' }, ADMIN),
    (e: unknown) => e instanceof AppError && e.statusCode === 400 && e.code === 'VALIDATION_ERROR' && /\{scheduledAt\}, \{nope\}/.test(e.message),
  );
  assert.equal(rows.size, 0);
  assert.equal(audits.length, 0);
});

test('save and reset are audited with the key only; reset restores the default', async () => {
  const { service, audits } = setup();
  await service.saveTemplate('SUBMISSION_RECEIVED', { subject: 'S {role}', body: 'B {candidateCode}' }, ADMIN);
  const reset = await service.resetTemplate('SUBMISSION_RECEIVED', ADMIN);
  assert.equal(reset.isDefault, true);
  assert.equal(reset.body, DEFAULT_EMAIL_TEMPLATES.SUBMISSION_RECEIVED.body);
  assert.deepEqual(audits.map((a) => [a.action, a.metadata]), [
    ['EMAIL_TEMPLATE_UPDATED', { key: 'SUBMISSION_RECEIVED' }],
    ['EMAIL_TEMPLATE_RESET', { key: 'SUBMISSION_RECEIVED' }],
  ]);
});

test('preview renders sample data with the first active role, draft text and next-round fields', async () => {
  const { service } = setup();
  const p = await service.renderPreview('SHORTLISTED', {
    subject: 'Round {roundName} for {firstName}',
    nextRound: { name: 'Technical interview', scheduledAt: '2026-11-10T05:30:00.000Z' },
  });
  assert.equal(p.subject, 'Round Technical interview for Ajith');
  assert.match(p.text, /Quant Analyst/);
  assert.match(p.text, /10 Nov 2026, 11:00 am IST/);
  await assert.rejects(service.renderPreview('SHORTLISTED', { body: '{bogus}' }), (e: unknown) => e instanceof AppError && e.statusCode === 400);
});

test('test send goes to the signed-in admin and needs a configured channel', async () => {
  const ok = setup();
  assert.deepEqual(await ok.service.sendTest('SUBMISSION_RECEIVED', {}, ADMIN), { sentTo: 'admin@x.test' });
  assert.deepEqual(ok.sent.map((s) => s.to), ['admin@x.test']);

  const off = setup({ email: { ...READY, enabled: false } });
  await assert.rejects(off.service.sendTest('SUBMISSION_RECEIVED', {}, ADMIN), (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.code === 'EMAIL_NOT_CONFIGURED');
  assert.equal(off.sent.length, 0);
});

// ---- sending ------------------------------------------------------------------------

test('send refuses with EMAIL_NOT_CONFIGURED when the channel is not ready', async () => {
  for (const email of [{ ...READY, enabled: false }, { ...READY, sendMailToken: '' }]) {
    const { service, created } = setup({ candidates: [cand(1)], email });
    await assert.rejects(service.send(send({ candidateIds: [id(1)] }), ADMIN), (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.code === 'EMAIL_NOT_CONFIGURED');
    assert.equal(created.length, 0);
  }
});

test('send queues eligible candidates with the rendered current template and audits without PII', async () => {
  const { service, rows, created, enqueued, audits } = setup({ candidates: [cand(1), cand(2)] });
  rows.set('email_template.SUBMISSION_RECEIVED', { subject: 'Got it {firstName}', body: 'Hello {fullName}, {answeredCount}/{questionCount}' });
  const r = await service.send(send({ candidateIds: [id(1), id(2), id(1)] }), ADMIN);
  assert.deepEqual({ batchId: r.batchId, queued: r.queued, skipped: r.skipped }, { batchId: 'batch-1', queued: 2, skipped: [] });
  assert.deepEqual(created.map((c) => [c.toEmail, c.subject]), [['p1@x.test', 'Got it Person'], ['p2@x.test', 'Got it Person']]);
  assert.match(created[0]!.text, /Hello Person 1, 2\/3/);
  assert.deepEqual(enqueued, [['d0', 'd1']]);
  assert.deepEqual(audits[0], { adminId: ADMIN, action: 'EMAILS_QUEUED', entity: 'email_dispatch', entityId: 'batch-1', metadata: { template: 'SUBMISSION_RECEIVED', count: 2, batchId: 'batch-1' } });
  assert.doesNotMatch(JSON.stringify(audits), /@x\.test|Person/);
});

test('send skips each of the five reasons and still queues the rest', async () => {
  const candidates = [
    cand(1), // ok
    cand(2, { eligible: false }), // INELIGIBLE
    cand(3, { attempt: { ...submitted, status: 'IN_PROGRESS' } }), // NOT_SUBMITTED
    cand(4, { attempt: null }), // NOT_SUBMITTED
    cand(5), // ALREADY_SENT
  ];
  const { service, created } = setup({ candidates, active: [id(5)] });
  const r = await service.send(send({ candidateIds: [id(1), id(2), id(3), id(4), id(5), id(99)] }), ADMIN);
  assert.equal(r.queued, 1);
  assert.deepEqual(created.map((c) => c.candidateId), [id(1)]);
  assert.deepEqual(r.skipped.map((s) => [s.candidateId, s.reason]), [
    [id(2), 'INELIGIBLE'],
    [id(3), 'NOT_SUBMITTED'],
    [id(4), 'NOT_SUBMITTED'],
    [id(5), 'ALREADY_SENT'],
    [id(99), 'NOT_FOUND'],
  ]);
  assert.deepEqual(r.skipped[0], { candidateId: id(2), candidateCode: 'ARC-0002', fullName: 'Person 2', reason: 'INELIGIBLE' });
  assert.deepEqual(r.skipped[4], { candidateId: id(99), candidateCode: null, fullName: null, reason: 'NOT_FOUND' });
});

test('an anonymised (purged) candidate is skipped as INELIGIBLE', async () => {
  const { service, created } = setup({ candidates: [cand(1, { email: 'anon+x@invalid' })] });
  const r = await service.send(send({ candidateIds: [id(1)] }), ADMIN);
  assert.equal(r.queued, 0);
  assert.equal(created.length, 0);
  assert.equal(r.skipped[0]?.reason, 'INELIGIBLE');
});

test('auto-submitted attempts count as submitted', async () => {
  const { service } = setup({ candidates: [cand(1, { attempt: { ...submitted, status: 'AUTO_SUBMITTED', submitType: 'AUTO' } })] });
  assert.equal((await service.send(send({ candidateIds: [id(1)] }), ADMIN)).queued, 1);
});

test('shortlisted template requires a SHORTLISTED result and uses the next-round details', async () => {
  const { service, created } = setup({ candidates: [cand(1, { status: 'EVALUATED', result: 'SHORTLISTED' }), cand(2, { status: 'EVALUATED' })] });
  const r = await service.send(
    { template: 'SHORTLISTED', candidateIds: [id(1), id(2)], nextRound: { name: 'HR round', link: 'https://meet.test/x', confirmBy: '2026-11-07T12:30:00.000Z' } },
    ADMIN,
  );
  assert.equal(r.queued, 1);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['NOT_SHORTLISTED']);
  assert.match(created[0]!.subject, /shortlisted for the HR round/);
  assert.match(created[0]!.html, /href="https:\/\/meet\.test\/x"/);
  assert.match(created[0]!.text, /Please confirm by: 7 Nov 2026, 6:00 pm IST/);
});

test('SHORTLISTED template checks result not status', async () => {
  const { service } = setup({ candidates: [cand(1, { status: 'EVALUATED', result: 'SHORTLISTED' }), cand(2, { status: 'SHORTLISTED', result: null })] });
  const r = await service.send({ template: 'SHORTLISTED', candidateIds: [id(1), id(2)] }, ADMIN);
  assert.equal(r.queued, 1);
  assert.deepEqual(r.skipped.map((s) => [s.candidateId, s.reason]), [[id(2), 'NOT_SHORTLISTED']]);
});

test('REJECTED template skips non-rejected as NOT_REJECTED and renders the not-selected email', async () => {
  const { service, created } = setup({
    candidates: [cand(1, { status: 'EVALUATED', result: 'REJECTED' }), cand(2, { status: 'EVALUATED', result: 'SHORTLISTED' }), cand(3, { status: 'EVALUATED' })],
  });
  const r = await service.send({ template: 'REJECTED', candidateIds: [id(1), id(2), id(3)] }, ADMIN);
  assert.equal(r.queued, 1);
  assert.deepEqual(r.skipped.map((s) => [s.candidateId, s.reason]), [[id(2), 'NOT_REJECTED'], [id(3), 'NOT_REJECTED']]);
  assert.equal(created[0]!.template, 'REJECTED');
  assert.equal(created[0]!.subject, 'Update on your application — Backend Engineer');
});

test('REJECTED preview renders with sample data', async () => {
  const { service } = setup();
  const p = await service.renderPreview('REJECTED', {});
  assert.equal(p.subject, 'Update on your application — Quant Analyst');
  assert.match(p.html, /Dear Ajith,/);
});

test('resend queues candidates who already have a QUEUED or SENT email', async () => {
  const { service, created } = setup({ candidates: [cand(5)], active: [id(5)] });
  const blocked = await service.send(send({ candidateIds: [id(5)] }), ADMIN);
  assert.equal(blocked.queued, 0);
  assert.equal(created.length, 0);
  const again = await service.send(send({ candidateIds: [id(5)], resend: true }), ADMIN);
  assert.equal(again.queued, 1);
  assert.deepEqual(again.skipped, []);
});

test('nothing eligible: no audit row, no jobs', async () => {
  const { service, audits, enqueued } = setup({ candidates: [] });
  const r = await service.send(send({ candidateIds: [id(1)] }), ADMIN);
  assert.equal(r.queued, 0);
  assert.equal(audits.length, 0);
  assert.equal(enqueued.length, 0);
});

test('if the queue is down the dispatches are failed, not left QUEUED, and the error surfaces', async () => {
  const { service, failed } = setup({ candidates: [cand(1)], enqueueFails: true });
  await assert.rejects(service.send(send({ candidateIds: [id(1)] }), ADMIN), /redis down/);
  assert.deepEqual(failed, [{ ids: ['d0'], error: 'Could not be queued for sending' }]);
});

// ---- worker -------------------------------------------------------------------------

function processorSetup(row: Partial<QueuedDispatch> | null, sendError?: Error, outcomeCc?: () => Promise<string[]>) {
  const state = { status: row?.status ?? 'QUEUED', attempts: 0, error: null as string | null };
  const sent: string[] = [];
  const ccs: (string[] | undefined)[] = [];
  const repo: DispatchRepository = {
    async findForSend() {
      return row
        ? { id: 'd1', status: state.status as QueuedDispatch['status'], template: 'SUBMISSION_RECEIVED', candidateResult: null, toEmail: 'c@x.test', subject: 's', html: '<p>h</p>', text: 't', ...row }
        : null;
    },
    async markSent() {
      if (state.status !== 'QUEUED') return false;
      state.status = 'SENT';
      state.attempts++;
      return true;
    },
    async recordFailure(_id, error, final) {
      state.attempts++;
      state.error = error;
      if (final) state.status = 'FAILED';
    },
  };
  const process = createDispatchProcessor({
    repo,
    sendEmail: async (p) => {
      if (sendError) throw sendError;
      sent.push(p.to);
      ccs.push(p.cc);
    },
    outcomeCc,
  });
  return { process, state, sent, ccs };
}

test('worker copies the CC list on outcome emails, minus the candidate, and never on the submission email', async () => {
  const cc = async () => ['hr@x.test', 'C@X.test', 'lead@x.test'];
  const shortlisted = processorSetup({ template: 'SHORTLISTED', candidateResult: 'SHORTLISTED' }, undefined, cc);
  await shortlisted.process('d1', { finalAttempt: false });
  assert.deepEqual(shortlisted.ccs, [['hr@x.test', 'lead@x.test']]);

  const rejected = processorSetup({ template: 'REJECTED', candidateResult: 'REJECTED' }, undefined, cc);
  await rejected.process('d1', { finalAttempt: false });
  assert.deepEqual(rejected.ccs, [['hr@x.test', 'lead@x.test']]);

  const submission = processorSetup({}, undefined, cc);
  await submission.process('d1', { finalAttempt: false });
  assert.deepEqual(submission.ccs, [undefined]);

  const empty = processorSetup({ template: 'REJECTED', candidateResult: 'REJECTED' }, undefined, async () => []);
  await empty.process('d1', { finalAttempt: false });
  assert.deepEqual(empty.ccs, [undefined]);
});

test('worker sends a QUEUED dispatch and marks it SENT', async () => {
  const { process, state, sent } = processorSetup({});
  assert.equal(await process('d1', { finalAttempt: false }), 'SENT');
  assert.deepEqual(sent, ['c@x.test']);
  assert.equal(state.status, 'SENT');
});

test('worker drops an outcome email whose result changed before sending, marking it FAILED', async () => {
  for (const [template, candidateResult] of [
    ['SHORTLISTED', 'REJECTED'],
    ['SHORTLISTED', null],
    ['REJECTED', 'SHORTLISTED'],
    ['REJECTED', null],
  ] as const) {
    const { process, state, sent } = processorSetup({ template, candidateResult });
    assert.equal(await process('d1', { finalAttempt: false }), 'SKIPPED');
    assert.equal(sent.length, 0);
    assert.equal(state.status, 'FAILED');
    assert.equal(state.error, 'Not sent: the result changed before the email went out');
  }
});

test('worker still sends an outcome email whose result is unchanged', async () => {
  const { process, sent } = processorSetup({ template: 'REJECTED', candidateResult: 'REJECTED' });
  assert.equal(await process('d1', { finalAttempt: false }), 'SENT');
  assert.deepEqual(sent, ['c@x.test']);
});

test('worker is a no-op unless the dispatch is QUEUED (or exists)', async () => {
  for (const status of ['SENT', 'FAILED'] as const) {
    const { process, sent } = processorSetup({ status });
    assert.equal(await process('d1', { finalAttempt: true }), 'SKIPPED');
    assert.equal(sent.length, 0);
  }
  const missing = processorSetup(null);
  assert.equal(await missing.process('nope', { finalAttempt: true }), 'SKIPPED');
});

test('worker keeps the row QUEUED on a failed attempt and FAILED only on the last, never storing the body', async () => {
  const err = new MessagingError('ZatpatMail request timed out', 'TIMEOUT', true);
  const retry = processorSetup({}, err);
  await assert.rejects(retry.process('d1', { finalAttempt: false }), /timed out/);
  assert.equal(retry.state.status, 'QUEUED');
  assert.equal(retry.state.attempts, 1);

  const last = processorSetup({}, err);
  await assert.rejects(last.process('d1', { finalAttempt: true }), /timed out/);
  assert.equal(last.state.status, 'FAILED');
  assert.equal(last.state.error, 'ZatpatMail request timed out');
  assert.doesNotMatch(last.state.error ?? '', /<p>|c@x\.test/);
});
