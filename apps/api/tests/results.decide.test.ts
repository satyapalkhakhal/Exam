import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateDecisionBulkInput, EmailSendInput, EmailSendResultDto } from '@exam/shared';
import { createResultsService, type ResultsDeps } from '../src/modules/results/results.service.js';
import type { ResultsRepository } from '../src/modules/results/results.repository.js';
import { AppError } from '../src/shared/errors.js';

const ACTOR = { id: '00000000-0000-4000-8000-0000000000aa', ip: '127.0.0.1' };
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';

type DecideMany = ResultsRepository['decideMany'];

function setup(opts: {
  decided?: string[];
  skipped?: Awaited<ReturnType<DecideMany>>['skipped'];
  emailReady?: boolean;
  sendResult?: Partial<EmailSendResultDto>;
  sendFails?: boolean;
} = {}) {
  const repoCalls: Parameters<DecideMany>[] = [];
  const sends: EmailSendInput[] = [];
  let readyChecks = 0;
  const repo = {
    async decideMany(...args: Parameters<DecideMany>) {
      repoCalls.push(args);
      return { decided: opts.decided ?? [], skipped: opts.skipped ?? [] };
    },
  } as unknown as ResultsRepository;
  const deps: ResultsDeps = {
    repo,
    getFlagsBatch: async () => new Map(),
    emailReady: async () => {
      readyChecks++;
      return opts.emailReady ?? true;
    },
    sendEmails: async (input) => {
      sends.push(input);
      if (opts.sendFails) throw new Error('redis down');
      return { batchId: 'b1', queued: input.candidateIds.length, skipped: [], ...opts.sendResult };
    },
  };
  return { service: createResultsService(deps), repoCalls, sends, readyChecks: () => readyChecks };
}

const input = (over: Partial<CandidateDecisionBulkInput> = {}): CandidateDecisionBulkInput => ({
  candidateIds: [A, B, C],
  decision: 'SHORTLISTED',
  sendEmail: true,
  ...over,
});

test('sendEmail with email not ready → 409 EMAIL_NOT_CONFIGURED and repo.decideMany not called', async () => {
  const { service, repoCalls } = setup({ emailReady: false, decided: [A] });
  await assert.rejects(service.decideMany(input(), ACTOR), (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.code === 'EMAIL_NOT_CONFIGURED');
  assert.equal(repoCalls.length, 0);
});

test('decideMany: mixed selection decides some, emails only those, passes skips through', async () => {
  const ineligible = { candidateId: A, candidateCode: 'ARC-1', fullName: 'P1', reason: 'INELIGIBLE' as const };
  const { service, repoCalls, sends } = setup({
    decided: [A],
    skipped: [
      { candidateId: B, candidateCode: 'ARC-2', fullName: 'P2', reason: 'ALREADY_DECIDED' },
      { candidateId: C, candidateCode: 'ARC-3', fullName: 'P3', reason: 'NOT_EVALUATED' },
    ],
    sendResult: { queued: 0, skipped: [ineligible] },
  });
  const nextRound = { name: 'HR round' };
  const r = await service.decideMany(input({ comment: 'Strong', nextRound }), ACTOR);
  assert.equal(repoCalls[0]![1], 'SHORTLISTED');
  assert.equal(repoCalls[0]![2], ACTOR.id);
  assert.equal(repoCalls[0]![3], 'Strong');
  assert.deepEqual(sends, [{ template: 'SHORTLISTED', candidateIds: [A], nextRound, resend: true }]);
  assert.deepEqual(r, {
    updated: 1,
    emailsQueued: 0,
    emailError: null,
    skipped: [
      { candidateId: B, candidateCode: 'ARC-2', fullName: 'P2', reason: 'ALREADY_DECIDED' },
      { candidateId: C, candidateCode: 'ARC-3', fullName: 'P3', reason: 'NOT_EVALUATED' },
    ],
    emailSkipped: [ineligible],
  });
});

test('switching result queues the other template, without next-round details', async () => {
  const { service, sends } = setup({ decided: [A] });
  const r = await service.decideMany(input({ decision: 'REJECTED', candidateIds: [A], nextRound: { name: 'x' } }), ACTOR);
  assert.deepEqual(sends, [{ template: 'REJECTED', candidateIds: [A], nextRound: undefined, resend: true }]);
  assert.equal(r.emailsQueued, 1);
});

test('sendEmail false never calls sendEmails or emailReady', async () => {
  const { service, sends, readyChecks } = setup({ decided: [A, B] });
  const r = await service.decideMany(input({ sendEmail: false }), ACTOR);
  assert.equal(sends.length, 0);
  assert.equal(readyChecks(), 0);
  assert.deepEqual({ updated: r.updated, emailsQueued: r.emailsQueued, emailError: r.emailError }, { updated: 2, emailsQueued: 0, emailError: null });
});

test('no decided candidates → sendEmails not called, emailsQueued 0', async () => {
  const { service, sends } = setup({ decided: [], skipped: [{ candidateId: A, candidateCode: null, fullName: null, reason: 'NOT_FOUND' }] });
  const r = await service.decideMany(input({ candidateIds: [A] }), ACTOR);
  assert.equal(sends.length, 0);
  assert.equal(r.emailsQueued, 0);
  assert.equal(r.updated, 0);
});

test('enqueue failure keeps results and reports emailError', async () => {
  const { service } = setup({ decided: [A], sendFails: true });
  const r = await service.decideMany(input({ candidateIds: [A] }), ACTOR);
  assert.deepEqual(
    { updated: r.updated, emailsQueued: r.emailsQueued, emailError: r.emailError },
    { updated: 1, emailsQueued: 0, emailError: 'Results saved, but the emails could not be queued. Use Send email to retry.' },
  );
});

test('the audit record names the batch decision with from/to result', async () => {
  const { service, repoCalls } = setup({ decided: [A] });
  await service.decideMany(input({ candidateIds: [A], decision: 'REJECTED', sendEmail: false }), ACTOR);
  const audit = repoCalls[0]![4](A, 'SHORTLISTED');
  assert.deepEqual(audit, {
    adminId: ACTOR.id,
    action: 'CANDIDATE_DECISION',
    entity: 'candidate',
    entityId: A,
    metadata: { from: 'SHORTLISTED', to: 'REJECTED', comment: null, batch: true },
    ip: ACTOR.ip,
  });
});
