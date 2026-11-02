// tests/exam.multi.test.ts
// Multiple exams per candidate account (docs/multi-exam.md): the application
// ownership check (404), one exam at a time (ANOTHER_EXAM_IN_PROGRESS) and the
// candidate's exam list (progress mapping, ordering, expired attempts settled
// on read). The service runs against an in-memory repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../src/shared/errors.js';
import { resolveApplication } from '../src/shared/middleware/resolveApplication.js';
import { createExamService, type ExamServiceDeps } from '../src/modules/exam/exam.service.js';
import type { ExamRepository } from '../src/modules/exam/exam.repository.js';
import type { ClientInfo } from '../src/shared/utils/clientInfo.js';

const client = { ip: '10.0.0.1', userAgent: 'test' } as unknown as ClientInfo;
const NOW = new Date('2026-11-03T10:00:00.000Z');
const auth = { id: 'acc-1', sessionFamily: 'fam' };

function run(owns: boolean) {
  const req = { candidate: { id: 'acc-1', sessionFamily: 'f' }, params: { applicationId: 'app-9' } } as unknown as Request;
  return new Promise<{ err: unknown; req: Request }>((resolve) => {
    resolveApplication(async (acc, app) => owns && acc === 'acc-1' && app === 'app-9')(req, {} as Response, ((err?: unknown) => resolve({ err, req })) as NextFunction);
  });
}

test('resolveApplication: an application that is not the account\'s own or not eligible is a 404; an owned one is passed on', async () => {
  const denied = await run(false);
  assert.ok(denied.err instanceof AppError && denied.err.statusCode === 404);
  const allowed = await run(true);
  assert.equal(allowed.err, undefined);
  assert.equal(allowed.req.applicationId, 'app-9');
});

const settings = { durationMinutes: 60, isOpen: true, windowStart: null, windowEnd: null, instructions: 'Read.' };

interface FakeApp {
  id: string;
  candidateCode: string;
  status: string;
  locationExempt: boolean;
  jobRole: { id: string; name: string };
  attempt: null | {
    id: string; status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'RESET'; submitType: 'MANUAL' | 'AUTO' | null;
    startedAt: Date; endsAt: Date; submittedAt: Date | null; questionCount: number; answeredCount: number;
  };
}

function fixture(opts: { otherRunning?: boolean; apps?: FakeApp[] } = {}) {
  const created: string[] = [];
  const apps = opts.apps ?? [];
  const calls: Array<[string, string | undefined]> = [];
  const tx = {
    lockAccount: async () => true,
    holdRoleLocked: async () => true,
    lockCandidate: async () => ({ jobRoleId: 'role-b', status: 'NOT_STARTED', eligible: true }),
    findLiveAttempt: async () => null,
    hasOtherRunningAttempt: async () => opts.otherRunning ?? false,
    activeQuestions: async () => [{ id: 'q1', text: 'Q', maxMarks: 10 }],
    createAttempt: async () => {
      created.push('attempt');
      return 'att-new';
    },
    setCandidateStatus: async () => {},
    addActivity: async () => {},
    finish: async (id: string) => {
      const a = apps.find((x) => x.attempt?.id === id)!;
      a.attempt = { ...a.attempt!, status: 'AUTO_SUBMITTED', submitType: 'AUTO', submittedAt: NOW };
      a.status = 'AUTO_SUBMITTED';
      return { id, candidateId: a.id, status: 'AUTO_SUBMITTED' as const, endsAt: a.attempt.endsAt, activeSessionId: 's' };
    },
    candidateStatus: async () => 'IN_PROGRESS',
    writeFinalVersions: async () => {},
  };
  const repo = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    findCandidate: async (id: string) => ({ id, accountId: 'acc-1', eligible: true, locationExempt: true, jobRoleId: 'role-b', status: 'NOT_STARTED' }),
    findLiveAttempt: async () => null,
    listApplications: async (acc: string, appId?: string) => {
      calls.push([acc, appId]);
      return apps.filter((a) => !appId || a.id === appId).map((a) => structuredClone(a));
    },
    loadState: async () => ({ id: 'att-new', status: 'IN_PROGRESS', startedAt: NOW, endsAt: NOW, questions: [] }),
  } as unknown as ExamRepository;
  const deps: ExamServiceDeps = {
    repo,
    getSettings: async () => settings,
    recordStartLocation: async () => {},
    queue: { enqueue: async () => {}, remove: async () => {} },
    bindFamily: async () => {},
    now: () => NOW,
  };
  return { service: createExamService(deps), created, calls };
}

test('start while another application of the account has a running attempt is 409 ANOTHER_EXAM_IN_PROGRESS and creates nothing', async () => {
  const f = fixture({ otherRunning: true });
  await assert.rejects(
    f.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client),
    (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.code === 'ANOTHER_EXAM_IN_PROGRESS',
  );
  assert.deepEqual(f.created, []);
  const free = fixture();
  await free.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client);
  assert.deepEqual(free.created, ['attempt']);
});

test('start refuses an application that belongs to another account', async () => {
  const f = fixture();
  await assert.rejects(f.service.start({ id: 'someone-else', sessionFamily: 'f' }, 'app-b', { location: { permission: 'GRANTED', latitude: 1, longitude: 1 } }, client), (e: unknown) => e instanceof AppError && e.statusCode === 403);
});

const attempt = (id: string, status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED', endsAt: Date, answered = 1) => ({
  id, status, submitType: status === 'SUBMITTED' ? ('MANUAL' as const) : null, startedAt: new Date(NOW.getTime() - 3_600_000), endsAt,
  submittedAt: status === 'IN_PROGRESS' ? null : NOW, questionCount: 3, answeredCount: answered,
});
const fakeApp = (id: string, role: string, status: string, att: FakeApp['attempt'] = null): FakeApp => ({
  id, candidateCode: `C-${id}`, status, locationExempt: false, jobRole: { id: `r-${role}`, name: role }, attempt: att,
});

test('the exam list maps every post-submit status to SUBMITTED and keeps the repository order', async () => {
  const future = new Date(NOW.getTime() + 600_000);
  const f = fixture({
    apps: [
      fakeApp('a', 'Analyst', 'NOT_STARTED'),
      fakeApp('b', 'Backend', 'IN_PROGRESS', attempt('t-b', 'IN_PROGRESS', future)),
      fakeApp('c', 'Clerk', 'EVALUATED', attempt('t-c', 'SUBMITTED', future)),
      fakeApp('d', 'Dealer', 'SHORTLISTED', attempt('t-d', 'SUBMITTED', future)),
      fakeApp('e', 'Editor', 'REJECTED', attempt('t-e', 'SUBMITTED', future)),
      fakeApp('f', 'Finance', 'AUTO_SUBMITTED', attempt('t-f', 'AUTO_SUBMITTED', future, 0)),
    ],
  });
  const list = await f.service.listExams('acc-1');
  assert.deepEqual(f.calls[0], ['acc-1', undefined]);
  assert.deepEqual(list.exams.map((e) => [e.jobRole.name, e.progress]), [
    ['Analyst', 'NOT_STARTED'], ['Backend', 'IN_PROGRESS'], ['Clerk', 'SUBMITTED'],
    ['Dealer', 'SUBMITTED'], ['Editor', 'SUBMITTED'], ['Finance', 'SUBMITTED'],
  ]);
  assert.equal(list.exams[0]!.attempt, null);
  assert.equal(list.exams[1]!.attempt?.answeredCount, 1);
  assert.equal(list.exams[5]!.attempt?.answeredCount, 0);
  assert.equal(list.exams[0]!.instructions, 'Read.');
  assert.equal(list.serverNow, NOW.toISOString());
});

test('an expired IN_PROGRESS attempt is settled to AUTO_SUBMITTED before the list is returned', async () => {
  const expired = new Date(NOW.getTime() - 60_000);
  const f = fixture({ apps: [fakeApp('b', 'Backend', 'IN_PROGRESS', attempt('t-b', 'IN_PROGRESS', expired))] });
  const [exam] = (await f.service.listExams('acc-1')).exams;
  assert.equal(exam!.progress, 'SUBMITTED');
  assert.equal(exam!.attempt?.status, 'AUTO_SUBMITTED');
  assert.equal(exam!.attempt?.submitType, 'AUTO');
});

test('getExam returns one application, and notFound when the account has no such eligible application', async () => {
  const f = fixture({ apps: [fakeApp('a', 'Analyst', 'NOT_STARTED')] });
  assert.equal((await f.service.getExam('acc-1', 'a')).exam.applicationId, 'a');
  await assert.rejects(f.service.getExam('acc-1', 'zzz'), (e: unknown) => e instanceof AppError && e.statusCode === 404);
});
