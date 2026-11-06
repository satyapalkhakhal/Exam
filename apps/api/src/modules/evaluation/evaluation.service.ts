// modules/evaluation/evaluation.service.ts
// Marking (design §8). One evaluator at a time holds a 30-minute soft lock on a
// script; every draft save or submit must hold it and refreshes it. A
// submitted evaluation cannot be locked. A draft may hold a comment without
// marks; an omitted comment keeps the stored one. Marks are
// validated here (0…max, steps of 0.5) whatever the client checked. Submit
// needs every question marked, computes the totals and moves the candidate to
// EVALUATED with history and an audit row, all in one transaction. Only a
// Super Admin can reopen a submitted evaluation, which clears any shortlist /
// reject result and returns the candidate to their submitted status. Blind marking is applied in
// the mapper, by the viewer's role.

import {
  EVALUATION_LOCK_MINUTES,
  type AdminRole,
  type EvaluationSaveInput,
  type LockDto,
  type MarkingViewDto,
  type Paginated,
  type SubmissionListQuery,
  type SubmissionViewDto,
} from '@exam/shared';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { num, toMarkingView, toSubmissionView } from './evaluation.mapper.js';
import type { EvaluationRepository, LockHolder } from './evaluation.repository.js';
import { percentageOf, validateMarks } from './marks.js';

export const LOCK_TTL_MS = EVALUATION_LOCK_MINUTES * 60_000;
const ENTITY = 'exam_attempt';

export interface EvaluationDeps {
  repo: EvaluationRepository;
  /** Per-candidate flag breakdown (numbers only, no location detail). */
  /** Per candidate: the numeric flag breakdown and the nearby-candidates count. */
  flagCounts: (candidateIds: string[]) => Promise<Map<string, { counts: Record<string, number>; nearbyCount: number | null }>>;
  now?: () => Date;
}

export interface Actor {
  id: string;
  role: AdminRole;
  ip: string | null;
}

export const evaluationLocked = (holder: LockHolder | null) =>
  new AppError(
    423,
    'EVALUATION_LOCKED',
    holder ? `Being marked by ${holder.name}` : 'You no longer hold the marking lock. Open the submission again to continue.',
    { lockedBy: holder },
  );

export function createEvaluationService(deps: EvaluationDeps) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());
  const cutoffFrom = (at: Date) => new Date(at.getTime() - LOCK_TTL_MS);

  async function list(q: SubmissionListQuery, role: AdminRole): Promise<Paginated<SubmissionViewDto>> {
    const { rows, total } = await repo.listSubmissions(q, role === 'SUPER_ADMIN');
    const flags = await deps.flagCounts(rows.map((r) => r.candidate.id));
    return {
      items: rows.map((r) => {
        const f = flags.get(r.candidate.id);
        return toSubmissionView({ ...r, attemptId: r.id, flags: f?.counts ?? {}, nearbyCount: f?.nearbyCount ?? null }, role);
      }),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Readable without the lock, so a second evaluator gets a read-only view. */
  async function marking(attemptId: string, role: AdminRole): Promise<MarkingViewDto> {
    const a = await repo.marking(attemptId);
    if (!a) throw notFound('Submission not found');
    const flags = await deps.flagCounts([a.candidate.id]);
    const f = flags.get(a.candidate.id);
    return toMarkingView({ ...a, attemptId: a.id, flags: f?.counts ?? {}, nearbyCount: f?.nearbyCount ?? null }, role);
  }

  async function lock(attemptId: string, actor: Actor): Promise<LockDto> {
    if (!(await repo.submittedAttemptExists(attemptId))) throw notFound('Submission not found');
    const at = now();
    const r = await repo.acquireLock(attemptId, actor.id, at, cutoffFrom(at));
    if (r.result === 'SUBMITTED') throw conflict('Evaluation already submitted');
    if (r.result === 'HELD') throw evaluationLocked(r.holder);
    return { lockedBy: r.holder, lockedAt: r.lockedAt.toISOString() };
  }

  /** Releases only the caller's own lock; anything else is a no-op. */
  async function unlock(attemptId: string, actor: Actor): Promise<void> {
    await repo.releaseLock(attemptId, actor.id);
  }

  async function save(
    attemptId: string,
    input: EvaluationSaveInput,
    actor: Actor,
  ): Promise<{ evaluationStatus: 'DRAFT' } | { evaluationStatus: 'SUBMITTED'; totalMarks: number; maxMarks: number; percentage: number }> {
    return repo.transaction(async (tx) => {
      const attempt = await tx.attempt(attemptId);
      if (!attempt) throw notFound('Submission not found');
      const at = now();
      if (!(await tx.touchLock(attemptId, actor.id, at, cutoffFrom(at)))) {
        if ((await tx.evaluationStatus(attemptId))?.status === 'SUBMITTED') {
          throw conflict('This evaluation has been submitted. A Super Admin must reopen it before it can change.');
        }
        throw evaluationLocked(await tx.liveHolder(attemptId, cutoffFrom(at)));
      }

      const questions = await tx.questions(attemptId);
      const maxOf = new Map(questions.map((q) => [q.id, num(q.maxMarksSnapshot) ?? 0]));
      for (const item of input.items) {
        const max = maxOf.get(item.attemptQuestionId);
        if (max === undefined) {
          throw badRequest('This question is not part of the submission', 'VALIDATION_ERROR', { attemptQuestionId: item.attemptQuestionId });
        }
        if (item.marks !== null) validateMarks(item.marks, max, item.attemptQuestionId);
      }
      for (const item of input.items) {
        const comment = item.comment === undefined ? undefined : item.comment || null;
        await tx.setMark(item.attemptQuestionId, item.marks, comment, actor.id);
      }

      if (!input.submit) {
        await tx.markDraft(attemptId, actor.id);
        await tx.audit({
          adminId: actor.id,
          action: 'EVALUATION_DRAFT_SAVED',
          entity: ENTITY,
          entityId: attemptId,
          metadata: { items: input.items.length },
          ip: actor.ip,
        });
        return { evaluationStatus: 'DRAFT' as const };
      }

      const marks = new Map((await tx.marks(attemptId)).map((m) => [m.attemptQuestionId, num(m.marks) ?? 0]));
      // a comment-only row (null marks) still counts as unmarked
      const missing = questions.filter((q) => !marks.has(q.id)).sort((a, b) => a.order - b.order);
      if (missing.length > 0) {
        throw badRequest('Every question needs marks before the evaluation can be submitted', 'VALIDATION_ERROR', {
          missing: missing.map((q) => q.id),
        });
      }
      const totalMarks = [...marks.values()].reduce((a, b) => a + b, 0);
      const maxMarks = [...maxOf.values()].reduce((a, b) => a + b, 0);
      const totals = { totalMarks, maxMarks, percentage: percentageOf(totalMarks, maxMarks) };
      await tx.complete(attemptId, actor.id, at, totals);
      if (!(await tx.transitionCandidate(attempt.candidateId, attemptId, 'EVALUATED', actor.id, null))) {
        throw conflict('This attempt was reset while it was being marked.');
      }
      await tx.audit({ adminId: actor.id, action: 'EVALUATION_SUBMITTED', entity: ENTITY, entityId: attemptId, metadata: totals, ip: actor.ip });
      return { evaluationStatus: 'SUBMITTED' as const, ...totals };
    });
  }

  async function reopen(attemptId: string, reason: string, actor: Actor): Promise<{ evaluationStatus: 'DRAFT'; candidateStatus: string }> {
    return repo.transaction(async (tx) => {
      const attempt = await tx.attempt(attemptId);
      if (!attempt) throw notFound('Submission not found');
      if (!(await tx.reopen(attemptId))) throw conflict('Only a submitted evaluation can be reopened');
      const to = attempt.status === 'AUTO_SUBMITTED' ? 'AUTO_SUBMITTED' : 'SUBMITTED';
      const moved = await tx.transitionCandidate(attempt.candidateId, attemptId, to, actor.id, reason, { clearResult: true });
      if (!moved) throw conflict('This attempt has been reset.');
      await tx.audit({
        adminId: actor.id,
        action: 'EVALUATION_REOPENED',
        entity: ENTITY,
        entityId: attemptId,
        metadata: { reason, fromStatus: moved.from, toStatus: to, clearedResult: moved.fromResult },
        ip: actor.ip,
      });
      return { evaluationStatus: 'DRAFT' as const, candidateStatus: to };
    });
  }

  return { list, marking, lock, unlock, save, reopen };
}

export type EvaluationService = ReturnType<typeof createEvaluationService>;
