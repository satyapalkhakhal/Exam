// modules/aiEvaluation/aiEvaluation.repository.ts
// Prisma access for AI runs and scores. Only SUBMITTED / AUTO_SUBMITTED attempts
// are ever gradable (never IN_PROGRESS or RESET). A score and its run's counters
// change in one transaction, guarded on status QUEUED, so a retried or
// cancelled job can never double count.

import { prisma } from '../../infrastructure/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { driveDisplayName } from '@exam/shared';
import type { AiEvaluationRepository, RunRow, ScoreResult } from './aiEvaluation.service.js';

const SUBMITTED_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;

const runSelect = {
  id: true,
  model: true,
  promptVersion: true,
  status: true,
  total: true,
  done: true,
  failed: true,
  inputTokens: true,
  outputTokens: true,
  createdAt: true,
  finishedAt: true,
  drive: {
    select: { id: true, batch: true, college: { select: { shortCode: true } }, round: { select: { roundNumber: true, jobRole: { select: { name: true } } } } },
  },
  createdBy: { select: { name: true } },
} as const;

type RunRecord = Prisma.AiEvaluationRunGetPayload<{ select: typeof runSelect }>;
const toRunRow = ({ drive, ...r }: RunRecord): RunRow => ({
  ...r,
  drive: drive
    ? {
        id: drive.id,
        displayName: driveDisplayName({
          jobRoleName: drive.round.jobRole.name,
          roundNumber: drive.round.roundNumber,
          collegeShortCode: drive.college.shortCode,
          batch: drive.batch,
        }),
      }
    : null,
});

type Tx = Prisma.TransactionClient;

// Run is DONE once every score is settled; the status guard makes concurrent
// finishers harmless.
async function finishIfSettled(tx: Tx, runId: string, at: Date): Promise<void> {
  const run = await tx.aiEvaluationRun.findUniqueOrThrow({ where: { id: runId }, select: { total: true, done: true, failed: true } });
  if (run.done + run.failed >= run.total) {
    await tx.aiEvaluationRun.updateMany({ where: { id: runId, status: 'RUNNING' }, data: { status: 'DONE', finishedAt: at } });
  }
}

export const aiEvaluationRepository: AiEvaluationRepository = {
  async driveExamState(driveId) {
    const drive = await prisma.drive.findUnique({ where: { id: driveId }, select: { isOpen: true, windowEnd: true } });
    if (!drive) return null;
    const inProgress = await prisma.examAttempt.count({ where: { status: 'IN_PROGRESS', candidate: { driveId } } });
    return { inProgress, isOpen: drive.isOpen, windowEnd: drive.windowEnd };
  },

  async driveIdsOfAttempts(attemptIds) {
    const rows = await prisma.examAttempt.findMany({ where: { id: { in: attemptIds } }, select: { candidate: { select: { driveId: true } } } });
    return [...new Set(rows.map((r) => r.candidate.driveId))];
  },

  async gradableQuestions(scope) {
    const attemptWhere: Prisma.ExamAttemptWhereInput =
      'driveId' in scope
        ? { status: { in: [...SUBMITTED_STATUSES] }, candidate: { driveId: scope.driveId } }
        : { status: { in: [...SUBMITTED_STATUSES] }, id: { in: scope.attemptIds } };
    // MCQs are auto-marked at submit and never sent to the AI.
    const rows = await prisma.attemptQuestion.findMany({
      where: { attempt: attemptWhere, typeSnapshot: 'WRITTEN' },
      orderBy: [{ attemptId: 'asc' }, { order: 'asc' }],
      select: {
        id: true,
        maxMarksSnapshot: true,
        aiScores: { where: { OR: [{ status: 'DONE' }, { status: 'QUEUED', run: { status: 'RUNNING' } }] }, select: { status: true } },
      },
    });
    return rows.map((r) => ({
      attemptQuestionId: r.id,
      maxMarks: r.maxMarksSnapshot.toNumber(),
      hasDone: r.aiScores.some((s) => s.status === 'DONE'),
      hasQueued: r.aiScores.some((s) => s.status === 'QUEUED'),
    }));
  },

  createRun(data) {
    return prisma.$transaction(
      async (tx) => {
        const created = await tx.aiEvaluationRun.create({
          data: {
            driveId: data.driveId,
            model: data.model,
            promptVersion: data.promptVersion,
            createdById: data.createdById,
            total: data.items.length,
          },
          select: { id: true },
        });
        const scores = await tx.aiQuestionScore.createManyAndReturn({
          data: data.items.map((i) => ({ runId: created.id, attemptQuestionId: i.attemptQuestionId, maxMarks: i.maxMarks, model: data.model })),
          select: { id: true },
        });
        const run = await tx.aiEvaluationRun.findUniqueOrThrow({ where: { id: created.id }, select: runSelect });
        return { run: toRunRow(run), scoreIds: scores.map((s) => s.id) };
      },
      { timeout: 60_000 },
    );
  },

  async listRuns(driveId) {
    const rows = await prisma.aiEvaluationRun.findMany({
      where: driveId ? { driveId } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
      select: runSelect,
    });
    return rows.map(toRunRow);
  },

  async loadForGrading(scoreId) {
    const s = await prisma.aiQuestionScore.findUnique({
      where: { id: scoreId },
      select: {
        id: true,
        status: true,
        maxMarks: true,
        run: { select: { status: true } },
        attemptQuestion: {
          select: { textSnapshot: true, question: { select: { evaluatorGuidance: true } }, answer: { select: { text: true, wordCount: true } } },
        },
      },
    });
    if (!s) return null;
    return {
      id: s.id,
      status: s.status,
      runStatus: s.run.status,
      maxMarks: s.maxMarks.toNumber(),
      questionText: s.attemptQuestion.textSnapshot,
      guidance: s.attemptQuestion.question.evaluatorGuidance,
      answerText: s.attemptQuestion.answer?.text ?? '',
      wordCount: s.attemptQuestion.answer?.wordCount ?? 0,
    };
  },

  completeScore(scoreId, r: ScoreResult, at) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.aiQuestionScore.updateMany({
        where: { id: scoreId, status: 'QUEUED' },
        data: {
          status: 'DONE',
          marks: r.marks,
          rationale: r.rationale,
          strengths: r.strengths,
          improvements: r.improvements,
          confidence: r.confidence,
          concerns: r.concerns,
          model: r.model,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          error: null,
          completedAt: at,
        },
      });
      if (count !== 1) return false;
      const { runId } = await tx.aiQuestionScore.findUniqueOrThrow({ where: { id: scoreId }, select: { runId: true } });
      await tx.aiEvaluationRun.update({
        where: { id: runId },
        data: { done: { increment: 1 }, inputTokens: { increment: r.inputTokens }, outputTokens: { increment: r.outputTokens } },
      });
      await finishIfSettled(tx, runId, at);
      return true;
    });
  },

  failScore(scoreId, error, at) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.aiQuestionScore.updateMany({
        where: { id: scoreId, status: 'QUEUED' },
        data: { status: 'FAILED', error, completedAt: at },
      });
      if (count !== 1) return false;
      const { runId } = await tx.aiQuestionScore.findUniqueOrThrow({ where: { id: scoreId }, select: { runId: true } });
      await tx.aiEvaluationRun.update({ where: { id: runId }, data: { failed: { increment: 1 } } });
      await finishIfSettled(tx, runId, at);
      return true;
    });
  },

  cancelRun(runId, at) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.aiEvaluationRun.findUnique({ where: { id: runId }, select: { status: true } });
      if (!existing) return null;
      if (existing.status !== 'RUNNING') return { notRunning: true as const };
      const queued = await tx.aiQuestionScore.findMany({ where: { runId, status: 'QUEUED' }, select: { id: true } });
      await tx.aiQuestionScore.updateMany({ where: { runId, status: 'QUEUED' }, data: { status: 'FAILED', error: 'cancelled', completedAt: at } });
      await tx.aiEvaluationRun.update({
        where: { id: runId },
        data: { status: 'CANCELLED', finishedAt: at, failed: { increment: queued.length } },
      });
      const run = await tx.aiEvaluationRun.findUniqueOrThrow({ where: { id: runId }, select: runSelect });
      return { run: toRunRow(run), cancelledScoreIds: queued.map((q) => q.id) };
    });
  },
};
