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
import { createExamService, type DriveExamSettings, type ExamServiceDeps } from '../src/modules/exam/exam.service.js';
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

const settings: DriveExamSettings = {
  durationMinutes: 60, isOpen: true, windowStart: null, windowEnd: null, instructions: 'Read.',
  roundId: 'round-b', roundNumber: 1, roundCount: 1, jobProfileType: 'PLACEMENT', mcqNegativeMarks: 0,
};

interface FakeApp {
  id: string;
  candidateCode: string;
  status: string;
  locationExempt: boolean;
  jobRole: { id: string; name: string };
  driveId: string;
  attempt: null | {
    id: string; status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'RESET'; submitType: 'MANUAL' | 'AUTO' | null;
    startedAt: Date; endsAt: Date; submittedAt: Date | null; questionCount: number; answeredCount: number;
  };
}

function fixture(opts: { otherRunning?: boolean; heldNegative?: number; apps?: FakeApp[]; settings?: Partial<DriveExamSettings> | ((driveId: string) => Partial<DriveExamSettings>) } = {}) {
  const created: string[] = [];
  const createdInputs: { startedAt: Date; endsAt: Date; negativeMarks?: number }[] = [];
  const settingsFor = (driveId: string) => ({ ...settings, ...(typeof opts.settings === 'function' ? opts.settings(driveId) : (opts.settings ?? {})) });
  const apps = opts.apps ?? [];
  const calls: Array<[string, string | undefined]> = [];
  const tx = {
    lockAccount: async () => true,
    // The round row as read under its lock (the value the attempt must freeze).
    holdRoundLocked: async () => ({ mcqNegativeMarks: opts.heldNegative ?? 0 }),
    lockCandidate: async () => ({ driveId: 'drive-b', roundId: 'round-b', status: 'NOT_STARTED', eligible: true }),
    findLiveAttempt: async () => null,
    hasOtherRunningAttempt: async () => opts.otherRunning ?? false,
    activeQuestions: async () => [{ id: 'q1', text: 'Q', maxMarks: 10 }],
    createAttempt: async (input: { startedAt: Date; endsAt: Date; negativeMarks?: number }) => {
      created.push('attempt');
      createdInputs.push(input);
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
    markMcqs: async () => ({ mcqMarks: 0, mcqMaxMarks: 0, autoEvaluated: false }),
  };
  const repo = {
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    findCandidate: async (id: string) => ({ id, accountId: 'acc-1', eligible: true, locationExempt: true, driveId: 'drive-b', roundId: 'round-b', status: 'NOT_STARTED' }),
    findLiveAttempt: async () => null,
    // No location rows: every application's nearbyCount is null.
    locationRows: async () => [],
    grantedStartsBetween: async () => [],
    startIpCandidateCounts: async () => new Map(),
    listApplications: async (acc: string, appId?: string) => {
      calls.push([acc, appId]);
      return apps.filter((a) => !appId || a.id === appId).map((a) => structuredClone(a));
    },
    loadState: async () => ({ id: 'att-new', status: 'IN_PROGRESS', startedAt: NOW, endsAt: NOW, questions: [] }),
  } as unknown as ExamRepository;
  const deps: ExamServiceDeps = {
    repo,
    getDriveSettings: async (driveId: string) => settingsFor(driveId),
    recordStartLocation: async () => {},
    queue: { enqueue: async () => {}, remove: async () => {} },
    bindFamily: async () => {},
    now: () => NOW,
  };
  return { service: createExamService(deps), created, createdInputs, calls };
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
  id, candidateCode: `C-${id}`, status, locationExempt: false, jobRole: { id: `r-${role}`, name: role }, driveId: `d-${role}`, attempt: att,
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

test('availability comes from the drive, duration from the round', async () => {
  const closed = fixture({ settings: { isOpen: false } });
  await assert.rejects(
    closed.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client),
    (e: unknown) => e instanceof AppError && e.statusCode === 403 && e.code === 'EXAM_NOT_OPEN',
  );
  assert.deepEqual(closed.created, []);
  const open = fixture({ settings: { isOpen: true, durationMinutes: 45 } });
  await open.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client);
  const made = open.createdInputs[0]!;
  assert.equal(made.endsAt.getTime() - made.startedAt.getTime(), 45 * 60_000);
});

test('the start is refused when the entry moved to a drive of another round meanwhile', async () => {
  const moved = fixture({ settings: { roundId: 'round-other' } });
  await assert.rejects(
    moved.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client),
    (e: unknown) => e instanceof AppError && e.statusCode === 409,
  );
});

test('roundNumber null with one round, 2 with two; type and window come from the drive', async () => {
  const f = fixture({
    apps: [fakeApp('a', 'Analyst', 'NOT_STARTED'), fakeApp('b', 'Backend', 'NOT_STARTED')],
    settings: (driveId) =>
      driveId === 'd-Backend'
        ? { roundNumber: 2, roundCount: 2, jobProfileType: 'INTERNSHIP', windowStart: new Date('2026-11-04T04:00:00Z') }
        : { roundNumber: 1, roundCount: 1 },
  });
  const list = await f.service.listExams('acc-1');
  assert.deepEqual(
    list.exams.map((e) => [e.jobRole.name, e.roundNumber, e.jobProfileType, e.windowStart]),
    [['Analyst', null, 'PLACEMENT', null], ['Backend', 2, 'INTERNSHIP', '2026-11-04T04:00:00.000Z']],
  );
});

test('start freezes the negative marking read under the round lock, not the earlier settings read (review I1)', async () => {
  // Settings were read before the transaction (0); HR changed it to 0.5 before the round lock was taken.
  const f = fixture({ settings: { mcqNegativeMarks: 0 }, heldNegative: 0.5 });
  await f.service.start(auth, 'app-b', { location: { permission: 'DENIED' } }, client);
  assert.equal(f.createdInputs[0]!.negativeMarks, 0.5);
});
