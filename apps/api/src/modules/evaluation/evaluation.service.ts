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
  type AiAcceptInput,
  type AiAcceptResultDto,
  type AiAcceptSkipReason,
  type EvaluationSaveInput,
  type LockDto,
  type MarkingViewDto,
  type Paginated,
  type SubmissionListQuery,
  type SubmissionViewDto,
} from '@exam/shared';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import { num, toMarkingView, toSubmissionView } from './evaluation.mapper.js';
import type { EvaluationRepository, EvaluationTx, LockHolder } from './evaluation.repository.js';
import { percentageOf, validateMarks } from './marks.js';

export const LOCK_TTL_MS = EVALUATION_LOCK_MINUTES * 60_000;
const ENTITY = 'exam_attempt';

export interface EvaluationDeps {
  repo: EvaluationRepository;
  /** Per-candidate flag breakdown (numbers only, no location detail). */
  flagCounts: (candidateIds: string[]) => Promise<Map<string, Record<string, number>>>;
  now?: () => Date;
}

export interface Actor {
  id: string;
  role: AdminRole;
  ip: string | null;
}

/** Thrown inside a bulk-accept transaction to roll one script back when its attempt was reset meanwhile. */
class ScriptReset extends Error {
  constructor(public readonly candidateCode: string) {
    super('Attempt was reset');
  }
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
      items: rows.map((r) => toSubmissionView({ ...r, attemptId: r.id, flags: flags.get(r.candidate.id) ?? {} }, role)),
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
    return toMarkingView({ ...a, attemptId: a.id, flags: flags.get(a.candidate.id) ?? {} }, role);
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

      const totals = await complete(tx, attempt, attemptId, questions, actor, at, {});
      return { evaluationStatus: 'SUBMITTED' as const, ...totals };
    });
  }

  /**
   * The completion step shared by Submit and bulk accept: needs every question
   * marked, writes totals, moves the candidate to EVALUATED (history) and audits.
   */
  async function complete(
    tx: EvaluationTx,
    attempt: { candidateId: string },
    attemptId: string,
    questions: { id: string; order?: number; maxMarksSnapshot: Parameters<typeof num>[0] }[],
    actor: Actor,
    at: Date,
    auditExtra: Record<string, unknown>,
  ): Promise<{ totalMarks: number; maxMarks: number; percentage: number }> {
    const maxOf = new Map(questions.map((q) => [q.id, num(q.maxMarksSnapshot) ?? 0]));
    const marks = new Map((await tx.marks(attemptId)).map((m) => [m.attemptQuestionId, num(m.marks) ?? 0]));
    // a comment-only row (null marks) still counts as unmarked
    const missing = questions.filter((q) => !marks.has(q.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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
    await tx.audit({ adminId: actor.id, action: 'EVALUATION_SUBMITTED', entity: ENTITY, entityId: attemptId, metadata: { ...totals, ...auditExtra }, ip: actor.ip });
    return totals;
  }

  /**
   * Super Admin bulk accept of AI marks. Each script runs in its own
   * transaction and is either accepted or skipped with a reason; one script's
   * problem never blocks the rest. LOCKED means someone else holds a live lock.
   * By role, only scripts whose evaluation is not yet submitted are considered;
   * by attempt ids, an already submitted one is reported ALREADY_EVALUATED.
   */
  async function acceptAi(input: AiAcceptInput, actor: Actor): Promise<AiAcceptResultDto> {
    const onlyClean = input.onlyClean !== false;
    const attemptIds = input.jobRoleId ? await repo.openAttemptIdsForRole(input.jobRoleId) : (input.attemptIds ?? []);
    const candidateOf = await repo.candidateIdsOf(attemptIds);
    const flags = onlyClean ? await deps.flagCounts([...new Set(candidateOf.values())]) : new Map<string, Record<string, number>>();

    const skipped: AiAcceptResultDto['skipped'] = [];
    let accepted = 0;
    for (const attemptId of attemptIds) {
      const flagged = Object.values(flags.get(candidateOf.get(attemptId) ?? '') ?? {}).some((n) => n > 0);
      let outcome: Awaited<ReturnType<typeof acceptOne>>;
      try {
        outcome = await repo.transaction((tx) => acceptOne(tx, attemptId, actor, onlyClean, flagged));
      } catch (err) {
        if (!(err instanceof ScriptReset)) throw err;
        outcome = { ok: false, reason: 'NOT_SUBMITTED', candidateCode: err.candidateCode };
      }
      if (outcome.ok) accepted += 1;
      else skipped.push({ attemptId, candidateCode: outcome.candidateCode, reason: outcome.reason });
    }

    const byReason: Record<string, number> = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    await repo.recordAudit({
      adminId: actor.id,
      action: 'EVALUATIONS_BULK_ACCEPTED_AI',
      entity: ENTITY,
      metadata: { jobRoleId: input.jobRoleId ?? null, onlyClean, requested: attemptIds.length, accepted, skipped: skipped.length, byReason },
      ip: actor.ip,
    });
    return { accepted, skipped };
  }

  async function acceptOne(
    tx: EvaluationTx,
    attemptId: string,
    actor: Actor,
    onlyClean: boolean,
    flagged: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: AiAcceptSkipReason; candidateCode: string | null }> {
    const attempt = await tx.attemptAny(attemptId);
    if (!attempt) return { ok: false, reason: 'NOT_FOUND', candidateCode: null };
    const code = attempt.candidate.candidateCode;
    const skip = (reason: AiAcceptSkipReason) => ({ ok: false as const, reason, candidateCode: code });
    if (attempt.status !== 'SUBMITTED' && attempt.status !== 'AUTO_SUBMITTED') return skip('NOT_SUBMITTED');

    const at = now();
    const ev = await tx.lockEvaluationRow(attemptId);
    if (ev.status === 'SUBMITTED') return skip('ALREADY_EVALUATED');
    if (ev.lockedById && ev.lockedById !== actor.id && ev.lockedAt && ev.lockedAt >= cutoffFrom(at)) return skip('LOCKED');

    const questions = await tx.questionsWithAi(attemptId);
    if (questions.length === 0 || questions.some((q) => !q.ai || q.ai.marks === null)) return skip('AI_INCOMPLETE');
    if (onlyClean) {
      if (questions.some((q) => (q.ai?.concerns.length ?? 0) > 0)) return skip('AI_CONCERNS');
      if (questions.some((q) => q.ai?.confidence === 'LOW')) return skip('LOW_CONFIDENCE');
      if (flagged) return skip('INTEGRITY_FLAGS');
    }

    for (const q of questions) {
      const ai = q.ai!;
      validateMarks(ai.marks!, q.maxMarks, q.id);
      await tx.setMarkFromAi(q.id, ai.marks!, ai.id, actor.id);
    }
    try {
      await complete(tx, attempt, attemptId, questions.map((q) => ({ id: q.id, maxMarksSnapshot: q.maxMarks })), actor, at, { viaAi: true });
    } catch (err) {
      // The attempt was reset while it was being accepted: roll this script back and skip it.
      if (err instanceof AppError && err.statusCode === 409) throw new ScriptReset(code);
      throw err;
    }
    return { ok: true };
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

  return { list, marking, lock, unlock, save, reopen, acceptAi };
}

export type EvaluationService = ReturnType<typeof createEvaluationService>;
