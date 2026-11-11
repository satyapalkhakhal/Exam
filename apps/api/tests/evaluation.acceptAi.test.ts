// Bulk accept of AI marks (Super Admin): every skip reason, the success path
// through the shared completion step (totals, EVALUATED move, history audit),
// per-script isolation and the single summary audit row. In-memory repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiAcceptSkipReason } from '@exam/shared';
import { createEvaluationService, type Actor } from '../src/modules/evaluation/evaluation.service.js';
import type { EvaluationRepository, EvaluationTx } from '../src/modules/evaluation/evaluation.repository.js';

const ACTOR: Actor = { id: 'admin-1', role: 'SUPER_ADMIN', ip: '127.0.0.1' };
const OTHER = 'admin-2';
const NOW = new Date('2026-11-06T10:00:00Z');
const ROLE = '00000000-0000-4000-8000-0000000000b1';

interface Q {
  id: string;
  maxMarks: number;
  ai: { id: string; marks: number | null; confidence: 'LOW' | 'MEDIUM' | 'HIGH'; concerns: string[] } | null;
}
interface Att {
  id: string;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED' | 'RESET';
  candidateId: string;
  code: string;
  evaluation: { status: 'DRAFT' | 'SUBMITTED'; lockedById: string | null; lockedAt: Date | null };
  questions: Q[];
  marks: Map<string, { marks: number; aiScoreId: string | null; evaluatorId: string }>;
  candidateStatus: string;
  resetOnTransition?: boolean;
}

const q = (id: string, over: Partial<Q> = {}, ai: Partial<NonNullable<Q['ai']>> | null = {}): Q => ({
  id,
  maxMarks: 10,
  ai: ai === null ? null : { id: `ai-${id}`, marks: 8, confidence: 'HIGH', concerns: [], ...ai },
  ...over,
});

function attempt(id: string, over: Partial<Att> = {}): Att {
  return {
    id,
    status: 'SUBMITTED',
    candidateId: `cand-${id}`,
    code: `ARH-${id}`,
    evaluation: { status: 'DRAFT', lockedById: null, lockedAt: null },
    questions: [q(`${id}-1`), q(`${id}-2`, {}, { marks: 6.5 })],
    marks: new Map(),
    candidateStatus: 'SUBMITTED',
    ...over,
  };
}

function setup(attempts: Att[], flags: Record<string, Record<string, number>> = {}) {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const audits: { action: string; entityId?: string; metadata?: Record<string, unknown> }[] = [];
  const transitions: { candidateId: string; to: string; by: string }[] = [];
  const fakeTx = (a: Att | undefined, staged: { audits: typeof audits; transitions: typeof transitions }) =>
    ({
      attemptAny: async () => (a ? { id: a.id, status: a.status, candidateId: a.candidateId, mcqMarks: null, mcqMaxMarks: 0, candidate: { candidateCode: a.code } } : null),
      lockEvaluationRow: async () => a!.evaluation,
      questionsWithAi: async () => a!.questions,
      setMarkFromAi: async (qid: string, marks: number, aiScoreId: string, evaluatorId: string) => void a!.marks.set(qid, { marks, aiScoreId, evaluatorId }),
      marks: async () => [...a!.marks].map(([attemptQuestionId, m]) => ({ attemptQuestionId, marks: m.marks })),
      complete: async (_id: string, evaluatorId: string) => void (a!.evaluation = { status: 'SUBMITTED', lockedById: null, lockedAt: null }, evaluatorId),
      transitionCandidate: async (candidateId: string, _att: string, to: string, by: string) => {
        if (a!.resetOnTransition) return null;
        a!.candidateStatus = to;
        staged.transitions.push({ candidateId, to, by });
        return { from: 'SUBMITTED', fromResult: null };
      },
      audit: async (e: (typeof audits)[number]) => void staged.audits.push(e),
    }) as unknown as EvaluationTx;
  // A transaction serves the attempt its first call (attemptAny) names; like a
  // real one, the writes of a throwing callback are discarded.
  let current: Att | undefined;
  const tx = (staged: { audits: typeof audits; transitions: typeof transitions }): EvaluationTx =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (prop === 'attemptAny') {
          return async (id: string) => {
            current = byId.get(id);
            return (fakeTx(current, staged) as unknown as Record<string, (...a: unknown[]) => unknown>).attemptAny!(id);
          };
        }
        return (fakeTx(current, staged) as unknown as Record<string, unknown>)[prop];
      },
    }) as unknown as EvaluationTx;
  const repo = {
    driveIdsOfAttempts: async (ids: string[]) => (ids.includes('other-drive') ? ['d1', 'd2'] : ['d1']),
    openAttemptIdsForDrive: async () => attempts.filter((a) => a.status === 'SUBMITTED' && a.evaluation.status !== 'SUBMITTED').map((a) => a.id),
    candidateIdsOf: async (ids: string[]) => new Map(ids.filter((i) => byId.has(i)).map((i) => [i, byId.get(i)!.candidateId])),
    recordAudit: async (e: (typeof audits)[number]) => void audits.push(e),
    transaction: async <T>(fn: (t: EvaluationTx) => Promise<T>): Promise<T> => {
      const staged = { audits: [] as typeof audits, transitions: [] as typeof transitions };
      const snapshot = new Map(attempts.map((a) => [a.id, new Map(a.marks)]));
      current = undefined;
      try {
        const r = await fn(tx(staged));
        audits.push(...staged.audits);
        transitions.push(...staged.transitions);
        return r;
      } catch (e) {
        for (const a of attempts) a.marks = snapshot.get(a.id)!;
        throw e;
      }
    },
  };
  const service = createEvaluationService({
    repo: repo as unknown as EvaluationRepository,
    flagCounts: async (ids) => new Map(ids.map((id) => [id, { counts: flags[id] ?? {}, nearbyCount: null }])),
    now: () => NOW,
  });
  return { service, audits, transitions, byId };
}

const reasonOf = (r: { skipped: { attemptId: string; reason: AiAcceptSkipReason }[] }, id: string) => r.skipped.find((s) => s.attemptId === id)?.reason;

test('accepts a clean script: AI marks written as the actor with provenance, totals, EVALUATED, audit', async () => {
  const a = attempt('a1');
  const { service, audits, transitions } = setup([a]);
  const r = await service.acceptAi({ attemptIds: ['a1'], onlyClean: true }, ACTOR);
  assert.deepEqual(r, { accepted: 1, skipped: [] });
  assert.deepEqual(a.marks.get('a1-1'), { marks: 8, aiScoreId: 'ai-a1-1', evaluatorId: 'admin-1' });
  assert.deepEqual(a.marks.get('a1-2'), { marks: 6.5, aiScoreId: 'ai-a1-2', evaluatorId: 'admin-1' });
  assert.equal(a.evaluation.status, 'SUBMITTED');
  assert.equal(a.candidateStatus, 'EVALUATED');
  assert.deepEqual(transitions, [{ candidateId: 'cand-a1', to: 'EVALUATED', by: 'admin-1' }]);
  const submitted = audits.find((x) => x.action === 'EVALUATION_SUBMITTED')!;
  assert.deepEqual(submitted.metadata, { totalMarks: 14.5, maxMarks: 20, percentage: 72.5, viaAi: true });
  const summary = audits.filter((x) => x.action === 'EVALUATIONS_BULK_ACCEPTED_AI');
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0]!.metadata, { driveId: null, onlyClean: true, requested: 1, accepted: 1, skipped: 0, byReason: {} });
});

test('each skip reason', async () => {
  const live = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - 3 * 60 * 60_000);
  const atts = [
    attempt('inprog', { status: 'IN_PROGRESS' }),
    attempt('reset', { status: 'RESET' }),
    attempt('done', { evaluation: { status: 'SUBMITTED', lockedById: null, lockedAt: null } }),
    attempt('locked', { evaluation: { status: 'DRAFT', lockedById: OTHER, lockedAt: live } }),
    attempt('incomplete', { questions: [q('i-1'), q('i-2', {}, null)] }),
    attempt('nomarks', { questions: [q('n-1', {}, { marks: null })] }),
    attempt('concern', { questions: [q('c-1', {}, { concerns: ['OFF_TOPIC'] })] }),
    attempt('low', { questions: [q('l-1', {}, { confidence: 'LOW' })] }),
    attempt('flagged'),
    attempt('okstale', { evaluation: { status: 'DRAFT', lockedById: OTHER, lockedAt: stale } }),
    attempt('okmine', { evaluation: { status: 'DRAFT', lockedById: 'admin-1', lockedAt: live } }),
  ];
  const { service } = setup(atts, { 'cand-flagged': { pasteAttempts: 2 } });
  const ids = [...atts.map((a) => a.id), 'ghost'];
  const r = await service.acceptAi({ attemptIds: ids, onlyClean: true }, ACTOR);
  const expected: Record<string, AiAcceptSkipReason> = {
    inprog: 'NOT_SUBMITTED',
    reset: 'NOT_SUBMITTED',
    done: 'ALREADY_EVALUATED',
    locked: 'LOCKED',
    incomplete: 'AI_INCOMPLETE',
    nomarks: 'AI_INCOMPLETE',
    concern: 'AI_CONCERNS',
    low: 'LOW_CONFIDENCE',
    flagged: 'INTEGRITY_FLAGS',
    ghost: 'NOT_FOUND',
  };
  for (const [id, reason] of Object.entries(expected)) assert.equal(reasonOf(r, id), reason, id);
  assert.equal(r.accepted, 2, 'a stale lock and my own lock do not block');
  assert.equal(r.skipped.find((s) => s.attemptId === 'ghost')?.candidateCode, null);
  assert.equal(r.skipped.find((s) => s.attemptId === 'locked')?.candidateCode, 'ARH-locked');
});

test('onlyClean false accepts scripts with concerns, LOW confidence and flags', async () => {
  const atts = [
    attempt('concern', { questions: [q('c-1', {}, { concerns: ['INCOHERENT'] })] }),
    attempt('low', { questions: [q('l-1', {}, { confidence: 'LOW' })] }),
    attempt('flagged'),
    attempt('incomplete', { questions: [q('i-1', {}, null)] }),
  ];
  const { service } = setup(atts, { 'cand-flagged': { pasteAttempts: 2 } });
  const r = await service.acceptAi({ attemptIds: atts.map((a) => a.id), onlyClean: false }, ACTOR);
  assert.equal(r.accepted, 3);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['AI_INCOMPLETE'], 'missing AI scores are never accepted');
});

test('a skipped script writes no marks', async () => {
  const a = attempt('c', { questions: [q('c-1'), q('c-2', {}, { concerns: ['OFF_TOPIC'] })] });
  const { service } = setup([a]);
  await service.acceptAi({ attemptIds: ['c'], onlyClean: true }, ACTOR);
  assert.equal(a.marks.size, 0);
  assert.equal(a.candidateStatus, 'SUBMITTED');
});

test('a script reset mid-accept is rolled back and reported NOT_SUBMITTED; the rest continue', async () => {
  const bad = attempt('bad', { resetOnTransition: true });
  const good = attempt('good');
  const { service } = setup([bad, good]);
  const r = await service.acceptAi({ attemptIds: ['bad', 'good'], onlyClean: true }, ACTOR);
  assert.equal(r.accepted, 1);
  assert.equal(reasonOf(r, 'bad'), 'NOT_SUBMITTED');
  assert.equal(bad.marks.size, 0, 'rolled back');
});

test('by role: only scripts whose evaluation is not yet submitted are considered', async () => {
  const done = attempt('done', { evaluation: { status: 'SUBMITTED', lockedById: null, lockedAt: null } });
  const open = attempt('open');
  const { service, audits } = setup([done, open]);
  const r = await service.acceptAi({ driveId: ROLE, onlyClean: true }, ACTOR);
  assert.deepEqual(r, { accepted: 1, skipped: [] });
  assert.equal(audits.at(-1)?.metadata?.driveId, ROLE);
});

test('the summary audit holds counts only, with a reason breakdown', async () => {
  const atts = [attempt('a'), attempt('b', { questions: [q('b-1', {}, { confidence: 'LOW' })] }), attempt('c', { questions: [q('c-1', {}, { confidence: 'LOW' })] })];
  const { service, audits } = setup(atts);
  await service.acceptAi({ attemptIds: ['a', 'b', 'c'], onlyClean: true }, ACTOR);
  const summary = audits.find((x) => x.action === 'EVALUATIONS_BULK_ACCEPTED_AI')!;
  assert.deepEqual(summary.metadata, { driveId: null, onlyClean: true, requested: 3, accepted: 1, skipped: 2, byReason: { LOW_CONFIDENCE: 2 } });
  assert.ok(!JSON.stringify(summary).includes('ARH-'), 'no candidate codes in the audit');
});

test('bulk accept on chosen attempts from two drives -> 400 MIXED_DRIVES, nothing accepted', async () => {
  const { service, audits } = setup([]);
  await assert.rejects(
    () => service.acceptAi({ attemptIds: ['a1', 'other-drive'] }, ACTOR),
    (e: unknown) => (e as { code?: string; statusCode?: number }).code === 'MIXED_DRIVES' && (e as { statusCode?: number }).statusCode === 400,
  );
  assert.equal(audits.length, 0);
});
