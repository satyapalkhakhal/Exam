// modules/exam/exam.repository.ts
// Prisma access for the exam engine. The rules live in exam.service; this file
// only reads, locks and writes. Writes that must agree with what was checked
// run inside `transaction`, whose methods take the row locks the service
// relies on:
// - start locks the candidate account row (one exam at a time per person),
//   then the role's exam_settings row, then the application's candidate row, so
//   two starts (or a start and a role change) serialise;
// - a save holds the attempt FOR SHARE and its answer FOR UPDATE, so two saves
//   of one answer apply in order and a submit cannot interleave with a save;
// - submit and auto-submit flip the status with a guarded update, so only one
//   of them (and only from IN_PROGRESS) can win.
// activity_logs are append-only: nothing here updates or deletes them.

import crypto from 'node:crypto';
import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
export type CandidateStatusValue = 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EVALUATED' | 'SHORTLISTED' | 'REJECTED';
export type AttemptStatusValue = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'RESET';

export interface ActivityEntry {
  candidateId: string;
  attemptId: string | null;
  eventType: string;
  questionId?: string | null;
  ip: string;
  sessionId?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface LiveAttempt {
  id: string;
  candidateId: string;
  status: AttemptStatusValue;
  endsAt: Date;
  activeSessionId: string;
}

const liveSelect = { id: true, candidateId: true, status: true, endsAt: true, activeSessionId: true } as const;

const activityData = (e: ActivityEntry): Prisma.ActivityLogCreateManyInput => ({
  candidateId: e.candidateId,
  attemptId: e.attemptId,
  eventType: e.eventType,
  questionId: e.questionId ?? null,
  ip: e.ip,
  sessionId: e.sessionId ?? null,
  userAgent: e.userAgent ?? null,
  metadata: (e.metadata ?? {}) as Prisma.InputJsonValue,
  ...(e.createdAt ? { createdAt: e.createdAt } : {}),
});

function txMethods(tx: Tx) {
  return {
    /**
     * Holds the role's exam_settings row so question writes (which take it FOR
     * UPDATE in the questions module) serialise with starts, and makes sure
     * questions_locked is true. Once the role is locked, starts only take it FOR
     * SHARE and run in parallel; only the first start(s) of a role take the
     * exclusive lock, through the guarded UPDATE, and never upgrade a share lock
     * they already hold. Returns false when the role has no settings row.
     */
    async holdRoleLocked(jobRoleId: string): Promise<boolean> {
      const plain = await tx.$queryRaw<{ questions_locked: boolean }[]>`
        SELECT questions_locked FROM exam_settings WHERE job_role_id = ${jobRoleId}::uuid`;
      if (!plain[0]) return false;
      if (plain[0].questions_locked) {
        const held = await tx.$queryRaw<{ questions_locked: boolean }[]>`
          SELECT questions_locked FROM exam_settings WHERE job_role_id = ${jobRoleId}::uuid FOR SHARE`;
        if (held[0]?.questions_locked) return true;
      }
      await tx.$executeRaw`
        UPDATE exam_settings SET questions_locked = true, updated_at = now()
        WHERE job_role_id = ${jobRoleId}::uuid AND questions_locked = false`;
      return true;
    },

    /** The account row FOR UPDATE: a person's starts serialise here. False when it does not exist. */
    async lockAccount(accountId: string): Promise<boolean> {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM candidate_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
      return rows.length > 0;
    },

    /** Another application of the account with an unexpired IN_PROGRESS attempt. */
    async hasOtherRunningAttempt(accountId: string, exceptApplicationId: string, at: Date): Promise<boolean> {
      const row = await tx.examAttempt.findFirst({
        where: { status: 'IN_PROGRESS', endsAt: { gt: at }, candidate: { accountId, id: { not: exceptApplicationId } } },
        select: { id: true },
      });
      return row !== null;
    },

    async lockCandidate(id: string) {
      const rows = await tx.$queryRaw<{ job_role_id: string; status: CandidateStatusValue; eligible: boolean }[]>`
        SELECT job_role_id::text, status::text AS status, eligible FROM candidates WHERE id = ${id}::uuid FOR UPDATE`;
      const r = rows[0];
      return r ? { jobRoleId: r.job_role_id, status: r.status, eligible: r.eligible } : null;
    },

    findLiveAttempt: (candidateId: string): Promise<LiveAttempt | null> =>
      tx.examAttempt.findFirst({ where: { candidateId, status: { not: 'RESET' } }, select: liveSelect }),

    async activeQuestions(jobRoleId: string) {
      const rows = await tx.question.findMany({
        where: { jobRoleId, active: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, text: true, maxMarks: true },
      });
      return rows.map((q) => ({ id: q.id, text: q.text, maxMarks: Number(q.maxMarks) }));
    },

    /** Creates the attempt, its question snapshots and one empty answer per question. */
    async createAttempt(input: {
      candidateId: string;
      startedAt: Date;
      endsAt: Date;
      sessionId: string;
      ip: string;
      userAgent: string;
      questions: { id: string; text: string; maxMarks: number }[];
    }): Promise<string> {
      const maxMarks = input.questions.reduce((s, q) => s + q.maxMarks, 0);
      const attempt = await tx.examAttempt.create({
        data: {
          candidateId: input.candidateId,
          status: 'IN_PROGRESS',
          startedAt: input.startedAt,
          endsAt: input.endsAt,
          activeSessionId: input.sessionId,
          startIp: input.ip,
          userAgent: input.userAgent,
          maxMarks,
        },
        select: { id: true },
      });
      const aqs = input.questions.map((q, i) => ({
        id: crypto.randomUUID(),
        attemptId: attempt.id,
        questionId: q.id,
        order: i + 1,
        textSnapshot: q.text,
        maxMarksSnapshot: q.maxMarks,
      }));
      await tx.attemptQuestion.createMany({ data: aqs });
      await tx.answer.createMany({ data: aqs.map((aq) => ({ attemptQuestionId: aq.id, lastSavedAt: input.startedAt })) });
      return attempt.id;
    },

    /** The attempt row FOR UPDATE, for submit: its session and status are checked under the lock. */
    async lockAttempt(attemptId: string) {
      const rows = await tx.$queryRaw<{ status: AttemptStatusValue; ends_at: Date; active_session_id: string }[]>`
        SELECT status::text AS status, ends_at, active_session_id FROM exam_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
      const r = rows[0];
      return r ? { status: r.status, endsAt: r.ends_at, activeSessionId: r.active_session_id } : null;
    },

    async setCandidateStatus(candidateId: string, from: CandidateStatusValue | null, to: CandidateStatusValue) {
      await tx.candidate.update({ where: { id: candidateId }, data: { status: to } });
      await tx.candidateStatusHistory.create({ data: { candidateId, fromStatus: from, toStatus: to } });
    },

    async candidateStatus(candidateId: string): Promise<CandidateStatusValue | null> {
      const c = await tx.candidate.findUnique({ where: { id: candidateId }, select: { status: true } });
      return c?.status ?? null;
    },

    async setSession(attemptId: string, sessionId: string) {
      await tx.examAttempt.update({ where: { id: attemptId }, data: { activeSessionId: sessionId } });
    },

    /** The attempt (FOR SHARE) and the answer (FOR UPDATE) behind one attempt question. */
    async lockForSave(attemptQuestionId: string) {
      const attempts = await tx.$queryRaw<
        { id: string; candidate_id: string; status: AttemptStatusValue; ends_at: Date; active_session_id: string }[]
      >`
        SELECT a.id::text, a.candidate_id::text, a.status::text AS status, a.ends_at, a.active_session_id
        FROM exam_attempts a JOIN attempt_questions q ON q.attempt_id = a.id
        WHERE q.id = ${attemptQuestionId}::uuid
        FOR SHARE OF a`;
      const a = attempts[0];
      if (!a) return null;
      const answers = await tx.$queryRaw<{ id: string; text: string; client_seq: number }[]>`
        SELECT id::text, text, client_seq FROM answers WHERE attempt_question_id = ${attemptQuestionId}::uuid FOR UPDATE`;
      const ans = answers[0];
      if (!ans) return null;
      return {
        attempt: { id: a.id, candidateId: a.candidate_id, status: a.status, endsAt: a.ends_at, activeSessionId: a.active_session_id },
        answer: { id: ans.id, text: ans.text, clientSeq: ans.client_seq },
      };
    },

    async updateAnswer(
      answerId: string,
      data: { text: string; wordCount: number; clientSeq: number; savedAt: Date; markedForReview?: boolean; visited?: boolean; flagged: boolean },
    ) {
      await tx.answer.update({
        where: { id: answerId },
        data: {
          text: data.text,
          wordCount: data.wordCount,
          clientSeq: data.clientSeq,
          lastSavedAt: data.savedAt,
          ...(data.markedForReview !== undefined ? { markedForReview: data.markedForReview } : {}),
          ...(data.visited !== undefined ? { visited: data.visited } : {}),
          ...(data.flagged ? { bulkInsertFlags: { increment: 1 } } : {}),
        },
      });
    },

    async lastVersionAt(answerId: string): Promise<Date | null> {
      const v = await tx.answerVersion.findFirst({ where: { answerId }, orderBy: { savedAt: 'desc' }, select: { savedAt: true } });
      return v?.savedAt ?? null;
    },

    async addVersion(answerId: string, text: string, wordCount: number, savedAt: Date) {
      await tx.answerVersion.create({ data: { answerId, text, wordCount, savedAt } });
    },

    /** IN_PROGRESS → final status, only if still IN_PROGRESS (and, for auto, past endsAt). */
    async finish(attemptId: string, to: 'SUBMITTED' | 'AUTO_SUBMITTED', now: Date, requireExpired: boolean): Promise<LiveAttempt | null> {
      const { count } = await tx.examAttempt.updateMany({
        where: { id: attemptId, status: 'IN_PROGRESS', ...(requireExpired ? { endsAt: { lte: now } } : {}) },
        data: { status: to, submittedAt: now, submitType: to === 'SUBMITTED' ? 'MANUAL' : 'AUTO' },
      });
      if (count === 0) return null;
      return tx.examAttempt.findUnique({ where: { id: attemptId }, select: liveSelect });
    },

    /** The "plus the final one" version (design §7.5): every saved answer whose latest version differs. */
    async writeFinalVersions(attemptId: string, now: Date) {
      const answers = await tx.answer.findMany({
        where: { attemptQuestion: { attemptId }, clientSeq: { gt: 0 } },
        select: { id: true, text: true, wordCount: true, versions: { orderBy: { savedAt: 'desc' }, take: 1, select: { text: true } } },
      });
      const missing = answers.filter((a) => a.versions[0]?.text !== a.text);
      if (missing.length > 0) {
        await tx.answerVersion.createMany({ data: missing.map((a) => ({ answerId: a.id, text: a.text, wordCount: a.wordCount, savedAt: now })) });
      }
    },

    async addActivity(e: ActivityEntry) {
      await tx.activityLog.create({ data: activityData(e) });
    },
  };
}

export type ExamTx = ReturnType<typeof txMethods>;

export const examRepository = {
  transaction<T>(fn: (r: ExamTx) => Promise<T>, opts: { maxWait?: number; timeout?: number } = {}): Promise<T> {
    return prisma.$transaction((tx) => fn(txMethods(tx)), { maxWait: opts.maxWait ?? 5_000, timeout: opts.timeout ?? 15_000 });
  },

  findCandidate(id: string) {
    return prisma.candidate.findUnique({
      where: { id },
      select: { id: true, accountId: true, eligible: true, locationExempt: true, jobRoleId: true, status: true },
    });
  },

  /** True when the application exists, is eligible and belongs to the account. */
  async ownsApplication(accountId: string, applicationId: string): Promise<boolean> {
    const row = await prisma.candidate.findFirst({ where: { id: applicationId, accountId, eligible: true }, select: { id: true } });
    return row !== null;
  },

  /** The account's eligible applications (one when `applicationId` is given), ordered by role name, with the current attempt and its counts. */
  async listApplications(accountId: string, applicationId?: string) {
    const rows = await prisma.candidate.findMany({
      where: { accountId, eligible: true, ...(applicationId ? { id: applicationId } : {}) },
      orderBy: [{ jobRole: { name: 'asc' } }, { id: 'asc' }],
      select: {
        id: true,
        candidateCode: true,
        status: true,
        locationExempt: true,
        jobRole: { select: { id: true, name: true } },
        attempts: {
          where: { status: { not: 'RESET' } },
          take: 1,
          select: { id: true, status: true, submitType: true, startedAt: true, endsAt: true, submittedAt: true },
        },
      },
    });
    const attemptIds = rows.flatMap((r) => r.attempts.map((a) => a.id));
    const counts = attemptIds.length
      ? await prisma.$queryRaw<{ attempt_id: string; total: bigint; answered: bigint }[]>`
          SELECT q.attempt_id::text AS attempt_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE a.word_count > 0) AS answered
          FROM attempt_questions q LEFT JOIN answers a ON a.attempt_question_id = q.id
          WHERE q.attempt_id = ANY(${attemptIds}::uuid[])
          GROUP BY q.attempt_id`
      : [];
    const byAttempt = new Map(counts.map((c) => [c.attempt_id, { questionCount: Number(c.total), answeredCount: Number(c.answered) }]));
    return rows.map((r) => {
      const a = r.attempts[0];
      return {
        id: r.id,
        candidateCode: r.candidateCode,
        status: r.status,
        locationExempt: r.locationExempt,
        jobRole: r.jobRole,
        attempt: a ? { ...a, ...(byAttempt.get(a.id) ?? { questionCount: 0, answeredCount: 0 }) } : null,
      };
    });
  },

  findLiveAttempt(candidateId: string): Promise<LiveAttempt | null> {
    return prisma.examAttempt.findFirst({ where: { candidateId, status: { not: 'RESET' } }, select: liveSelect });
  },

  async loadState(attemptId: string) {
    return prisma.examAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        endsAt: true,
        questions: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            order: true,
            textSnapshot: true,
            maxMarksSnapshot: true,
            answer: { select: { text: true, wordCount: true, clientSeq: true, markedForReview: true, visited: true, lastSavedAt: true } },
          },
        },
      },
    });
  },

  async loadSummary(attemptId: string) {
    const [attempt, questionCount, answeredCount] = await Promise.all([
      prisma.examAttempt.findUnique({ where: { id: attemptId }, select: { status: true, submitType: true, startedAt: true, submittedAt: true } }),
      prisma.attemptQuestion.count({ where: { attemptId } }),
      prisma.answer.count({ where: { attemptQuestion: { attemptId }, wordCount: { gt: 0 } } }),
    ]);
    return attempt ? { ...attempt, questionCount, answeredCount } : null;
  },

  async attemptQuestionIds(attemptId: string): Promise<Set<string>> {
    const rows = await prisma.attemptQuestion.findMany({ where: { attemptId }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  },

  async lastActivityIp(attemptId: string): Promise<string | null> {
    const row = await prisma.activityLog.findFirst({
      where: { attemptId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ip: true },
    });
    return row?.ip ?? null;
  },

  async addActivity(e: ActivityEntry) {
    await prisma.activityLog.create({ data: activityData(e) });
  },

  async addActivities(entries: ActivityEntry[]) {
    if (entries.length > 0) await prisma.activityLog.createMany({ data: entries.map(activityData) });
  },

  async listExpiredAttemptIds(cutoff: Date): Promise<string[]> {
    const rows = await prisma.examAttempt.findMany({
      where: { status: 'IN_PROGRESS', endsAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
      take: 500,
    });
    return rows.map((r) => r.id);
  },

  /** Integrity event counts per candidate, for their current (non-RESET) attempt only. */
  async integrityEventCounts(candidateIds: string[], eventTypes: string[]) {
    if (candidateIds.length === 0) return [];
    const rows = await prisma.activityLog.groupBy({
      by: ['candidateId', 'eventType'],
      where: { candidateId: { in: candidateIds }, eventType: { in: eventTypes }, attempt: { status: { not: 'RESET' } } },
      _count: { _all: true },
    });
    return rows.map((r) => ({ candidateId: r.candidateId, eventType: r.eventType, count: r._count._all }));
  },

  /** Login and start location rows for the candidates, oldest first. */
  async locationRows(candidateIds: string[]) {
    if (candidateIds.length === 0) return [];
    const rows = await prisma.candidateLoginLog.findMany({
      where: { candidateId: { in: candidateIds } },
      orderBy: { createdAt: 'asc' },
      select: { candidateId: true, stage: true, permission: true, latitude: true, longitude: true, ip: true, createdAt: true },
    });
    return rows.map((r) => ({
      candidateId: r.candidateId,
      stage: r.stage,
      permission: r.permission,
      lat: r.latitude === null ? null : Number(r.latitude),
      lng: r.longitude === null ? null : Number(r.longitude),
      ip: r.ip,
      createdAt: r.createdAt,
    }));
  },

  /** GRANTED EXAM_START rows of anyone, between two instants (the ±2 h nearby window). */
  async grantedStartsBetween(from: Date, to: Date) {
    const rows = await prisma.candidateLoginLog.findMany({
      where: { stage: 'EXAM_START', permission: 'GRANTED', createdAt: { gte: from, lte: to }, latitude: { not: null }, longitude: { not: null } },
      select: { candidateId: true, latitude: true, longitude: true, createdAt: true },
    });
    return rows.map((r) => ({ candidateId: r.candidateId, lat: Number(r.latitude), lng: Number(r.longitude), createdAt: r.createdAt }));
  },

  /** For each IP, how many distinct candidates have an EXAM_START row from it. */
  async startIpCandidateCounts(ips: string[]): Promise<Map<string, number>> {
    if (ips.length === 0) return new Map();
    const rows = await prisma.$queryRaw<{ ip: string; n: bigint }[]>`
      SELECT ip, COUNT(DISTINCT candidate_id) AS n FROM candidate_login_logs
      WHERE stage = 'EXAM_START' AND ip = ANY(${ips}::text[])
      GROUP BY ip`;
    return new Map(rows.map((r) => [r.ip, Number(r.n)]));
  },
};

export type ExamRepository = typeof examRepository;
