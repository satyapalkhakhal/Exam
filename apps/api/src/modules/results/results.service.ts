// modules/results/results.service.ts
// Super Admin outcomes (design §8, §9): the shortlist/reject decision (only
// after an evaluation, with history and audit), the per-role leaderboard
// (total marks desc, ties by earlier submit; or by composite / AI % on request),
// AI marks and the weighted composite (docs/ai-evaluation.md §7, §10), the dashboard counts every admin
// sees (numbers only, so nothing here is blind-marking sensitive), and the two
// XLSX exports. Marks, totals and comments are exported only once an
// evaluation is submitted; a draft or reopened one is work in progress.

import {
  DEFAULT_COMPOSITE_WEIGHTS,
  compositeScore,
  type CompositeWeights,
  type LeaderboardSort,
} from '@exam/shared';
import type {
  CandidateDecisionBulkInput,
  CandidateDecisionBulkResultDto,
  CandidateResult,
  DashboardRoleDto,
  DecisionInput,
  EmailSendInput,
  EmailSendResultDto,
  LeaderboardRowDto,
} from '@exam/shared';
import { conflict, notFound } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { CandidateFlags } from '../exam/index.js';
import { flagBreakdown, flagScore } from '../exam/index.js';
import { num, percentageOf, toCandidatePii } from '../evaluation/index.js';
import type { Cell, SheetSpec } from './exports.js';
import type { CandidateStatusValue, LiveAttemptRow, ResultsRepository, ScoredAttempt } from './results.repository.js';

export interface ResultsDeps {
  repo: ResultsRepository;
  getFlagsBatch: (candidateIds: string[]) => Promise<Map<string, CandidateFlags>>;
  /** True when the email integration can send (checked before any result changes). */
  emailReady: () => Promise<boolean>;
  /** The emails module's queued send (emails.send). */
  sendEmails: (input: EmailSendInput, adminId: string) => Promise<EmailSendResultDto>;
}

const EMAIL_NOT_CONFIGURED = 'Email is not set up. Configure it in Integrations.';
const EMAIL_QUEUE_FAILED = 'Results saved, but the emails could not be queued. Use Send email to retry.';

export interface Actor {
  id: string;
  ip: string | null;
}

const EMPTY_FLAGS: CandidateFlags = { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [] };

const STATUS_KEYS: Record<CandidateStatusValue, keyof DashboardRoleDto> = {
  NOT_STARTED: 'notStarted',
  IN_PROGRESS: 'inProgress',
  SUBMITTED: 'submitted',
  AUTO_SUBMITTED: 'autoSubmitted',
  EVALUATED: 'evaluated',
  SHORTLISTED: 'shortlisted',
  REJECTED: 'rejected',
};

const FLAG_COLUMNS = [
  { header: 'Paste/copy attempts', key: 'pasteAttempts' },
  { header: 'Bulk inserts', key: 'bulkInsert' },
  { header: 'IP changes', key: 'ipChanges' },
  { header: 'Location flags', key: 'locationFlags' },
  { header: 'Excessive tab switching', key: 'excessiveTabSwitching' },
] as const;

const minutes = (a: Date, b: Date | null): number | null => (b ? Math.round((b.getTime() - a.getTime()) / 6_000) / 10 : null);

interface RowScores {
  aiMarksByOrder: Map<number, number>;
  aiPercentage: number | null;
  composite: number | null;
  provisional: boolean;
}

/**
 * AI % (only when every question has a DONE AI score) and the composite. The
 * exam % in the composite is the human percentage once the evaluation is
 * submitted, else the AI % (provisional).
 */
export function scoreRow(r: ScoredAttempt, weights: CompositeWeights): RowScores {
  const aiMarksByOrder = new Map<number, number>();
  for (const q of r.questions) {
    const m = num(q.aiScores[0]?.marks ?? null);
    if (m !== null) aiMarksByOrder.set(q.order, m);
  }
  const allScored = r.questions.length > 0 && aiMarksByOrder.size === r.questions.length;
  const aiMax = r.questions.reduce((a, q) => a + (num(q.maxMarksSnapshot) ?? 0), 0);
  const aiPercentage = allScored ? percentageOf([...aiMarksByOrder.values()].reduce((a, b) => a + b, 0), aiMax) : null;
  const human = r.evaluation?.status === 'SUBMITTED' ? num(r.percentage) : null;
  const exam = human ?? aiPercentage;
  const c = r.candidate;
  const composite = compositeScore(
    { examPercentage: exam, xPercentage: num(c.xPercentage), xiiPercentage: num(c.xiiPercentage), majorCpi: num(c.majorCpi) },
    weights,
  );
  return { aiMarksByOrder, aiPercentage, composite, provisional: human === null && composite !== null };
}

const nullsLast = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);

export function createResultsService(deps: ResultsDeps) {
  const { repo } = deps;

  const decisionAudit = (actor: Actor, to: CandidateResult, comment: string | null, batch: boolean) => (candidateId: string, from: CandidateResult | null) => ({
    adminId: actor.id,
    action: 'CANDIDATE_DECISION',
    entity: 'candidate',
    entityId: candidateId,
    metadata: { from, to, comment, batch },
    ip: actor.ip,
  });

  /** Leaderboard's single decision, no email: the old 404/409 replies are kept. */
  async function decide(candidateId: string, input: DecisionInput, actor: Actor): Promise<{ candidateId: string; result: CandidateResult }> {
    const comment = input.comment ? input.comment : null;
    const r = await repo.decideMany([candidateId], input.decision, actor.id, comment, decisionAudit(actor, input.decision, comment, false));
    const skip = r.skipped[0];
    if (skip?.reason === 'NOT_FOUND') throw notFound('Candidate not found');
    if (skip?.reason === 'ALREADY_DECIDED') throw conflict(`The candidate is already ${input.decision.toLowerCase()}`);
    if (skip) throw conflict('A decision can only be made after the evaluation is submitted');
    return { candidateId, result: input.decision };
  }

  /**
   * Bulk shortlist/reject. Results commit first; then (sendEmail) the matching
   * email is queued for the candidates whose result changed, as a deliberate
   * re-send. A queue failure after the commit keeps the results and is reported.
   */
  async function decideMany(input: CandidateDecisionBulkInput, actor: Actor): Promise<CandidateDecisionBulkResultDto> {
    if (input.sendEmail && !(await deps.emailReady())) throw conflict(EMAIL_NOT_CONFIGURED, 'EMAIL_NOT_CONFIGURED');
    const comment = input.comment ? input.comment : null;
    const { decided, skipped } = await repo.decideMany(input.candidateIds, input.decision, actor.id, comment, decisionAudit(actor, input.decision, comment, true));
    const result: CandidateDecisionBulkResultDto = { updated: decided.length, emailsQueued: 0, emailError: null, skipped, emailSkipped: [] };
    if (!input.sendEmail || decided.length === 0) return result;
    try {
      const sent = await deps.sendEmails(
        { template: input.decision, candidateIds: decided, nextRound: input.decision === 'SHORTLISTED' ? input.nextRound : undefined, resend: true },
        actor.id,
      );
      result.emailsQueued = sent.queued;
      result.emailSkipped = sent.skipped;
    } catch (err) {
      logger.error('Decision emails could not be queued', { count: decided.length, error: err instanceof Error ? err.message : 'unknown' });
      result.emailError = EMAIL_QUEUE_FAILED;
    }
    return result;
  }

  async function leaderboard(jobRoleId: string, sort: LeaderboardSort = 'human'): Promise<{ items: LeaderboardRowDto[] }> {
    const [rows, weightsByRole] = await Promise.all([repo.leaderboard(jobRoleId, sort !== 'human'), repo.weightsFor([jobRoleId])]);
    const weights = weightsByRole.get(jobRoleId) ?? DEFAULT_COMPOSITE_WEIGHTS;
    const flags = await deps.getFlagsBatch(rows.map((r) => r.candidate.id));
    const scored = rows.map((r) => ({ r, s: scoreRow(r, weights) }));
    if (sort !== 'human') {
      const key = (x: (typeof scored)[number]) => (sort === 'composite' ? x.s.composite : x.s.aiPercentage);
      // Array.sort is stable and the repository order already has submittedAt asc as the tiebreak.
      scored.sort((a, b) => nullsLast(key(a), key(b)) || (a.r.submittedAt?.getTime() ?? Infinity) - (b.r.submittedAt?.getTime() ?? Infinity));
    }
    return {
      items: scored.map(({ r, s }, i) => ({
        rank: i + 1,
        candidateCode: r.candidate.candidateCode,
        ...toCandidatePii(r.candidate),
        status: r.candidate.status,
        result: r.candidate.result,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        totalMarks: num(r.totalMarks) ?? 0,
        maxMarks: num(r.maxMarks) ?? 0,
        percentage: num(r.percentage) ?? 0,
        questionMarks: r.questions.map((q) => ({
          order: q.order,
          marks: r.evaluation?.status === 'SUBMITTED' ? num(q.evaluation?.marks ?? null) : null,
          aiMarks: s.aiMarksByOrder.get(q.order) ?? null,
          maxMarks: num(q.maxMarksSnapshot) ?? 0,
        })),
        aiPercentage: s.aiPercentage,
        compositeScore: s.composite,
        compositeProvisional: s.provisional,
        flagCounts: flagBreakdown(flags.get(r.candidate.id) ?? EMPTY_FLAGS),
      })),
    };
  }

  async function dashboard(): Promise<{ roles: DashboardRoleDto[] }> {
    const [roles, counts] = await Promise.all([repo.roles(), repo.statusCounts()]);
    return {
      roles: roles.map((role) => {
        const dto: DashboardRoleDto = {
          jobRoleId: role.id,
          jobRoleName: role.name,
          refApplicantCount: role.refApplicantCount,
          imported: 0,
          notStarted: 0,
          inProgress: 0,
          submitted: 0,
          autoSubmitted: 0,
          evaluated: 0,
          shortlisted: 0,
          rejected: 0,
          pendingEvaluation: 0,
        };
        for (const c of counts) {
          if (c.jobRoleId !== role.id) continue;
          dto.imported += c.count;
          // A decided candidate counts under its result, not under "evaluated" (awaiting a decision).
          if (c.result) (dto[STATUS_KEYS[c.result]] as number) += c.count;
          else (dto[STATUS_KEYS[c.status]] as number) += c.count;
        }
        dto.pendingEvaluation = dto.submitted + dto.autoSubmitted;
        return dto;
      }),
    };
  }

  async function rolesFor(jobRoleId: string | undefined) {
    const roles = await repo.roles(jobRoleId);
    if (jobRoleId && roles.length === 0) throw notFound('Job role not found');
    return roles;
  }

  function resultsSheet(roleName: string, rows: ScoredAttempt[], flags: Map<string, CandidateFlags>, weights: CompositeWeights): SheetSpec {
    const qCount = Math.max(0, ...rows.flatMap((r) => r.questions.map((q) => q.order)));
    const orders = Array.from({ length: qCount }, (_, i) => i + 1);
    let rank = 0;
    const weightsText = `${weights.exam}/${weights.x}/${weights.xii}/${weights.cpi}`;
    return {
      name: roleName,
      columns: [
        { header: 'Rank', width: 6 },
        { header: 'Candidate code', width: 18 },
        { header: 'Name', width: 28 },
        { header: 'Email', width: 30 },
        { header: 'Mobile' },
        { header: 'Roll number' },
        { header: 'X %' },
        { header: 'XII %' },
        { header: 'Major CPI' },
        { header: 'Programme' },
        { header: 'Discipline', width: 24 },
        { header: 'Status' },
        { header: 'Result' },
        { header: 'Evaluation' },
        { header: 'Submitted at', width: 20 },
        { header: 'Submit type' },
        { header: 'Time taken (min)' },
        ...orders.map((o) => ({ header: `Q${o} marks` })),
        { header: 'Total' },
        { header: 'Max' },
        { header: 'Percentage' },
        ...orders.map((o) => ({ header: `Q${o} AI marks` })),
        { header: 'AI %' },
        { header: 'Composite' },
        { header: 'Composite basis' },
        { header: 'Weights (exam/X/XII/CPI)' },
        ...FLAG_COLUMNS.map((f) => ({ header: f.header })),
        { header: 'Flag score' },
        { header: 'Evaluator comments', width: 60 },
      ],
      rows: rows.map((r): Cell[] => {
        const c = r.candidate;
        const evaluated = r.evaluation?.status === 'SUBMITTED' && r.totalMarks !== null;
        const f = flags.get(c.id) ?? EMPTY_FLAGS;
        const breakdown = flagBreakdown(f);
        const byOrder = new Map(r.questions.map((q) => [q.order, q]));
        const sc = scoreRow(r, weights);
        return [
          evaluated ? ++rank : null,
          c.candidateCode,
          c.fullName,
          c.email,
          c.mobile,
          c.rollNumber,
          num(c.xPercentage),
          num(c.xiiPercentage),
          num(c.majorCpi),
          c.programme,
          c.discipline,
          c.status,
          c.result ?? '',
          r.evaluation?.status ?? 'PENDING',
          r.submittedAt,
          r.submitType,
          minutes(r.startedAt, r.submittedAt),
          ...orders.map((o) => (evaluated ? num(byOrder.get(o)?.evaluation?.marks ?? null) : null)),
          evaluated ? num(r.totalMarks) : null,
          evaluated ? num(r.maxMarks) : null,
          evaluated ? num(r.percentage) : null,
          ...orders.map((o) => sc.aiMarksByOrder.get(o) ?? null),
          sc.aiPercentage,
          sc.composite,
          sc.composite === null ? null : sc.provisional ? 'AI (provisional)' : 'Human',
          weightsText,
          ...FLAG_COLUMNS.map((col) => breakdown[col.key]),
          flagScore(f),
          r.questions
            .filter((q) => evaluated && q.evaluation?.comment)
            .map((q) => `Q${q.order}: ${q.evaluation!.comment}`)
            .join('\n') || null,
        ];
      }),
    };
  }

  async function resultsExport(jobRoleId: string | undefined): Promise<{ roleName: string | null; sheets: SheetSpec[] }> {
    const roles = await rolesFor(jobRoleId);
    const attempts = await repo.submittedAttempts(roles.map((r) => r.id));
    const flags = await deps.getFlagsBatch(attempts.map((a) => a.candidate.id));
    const weightsByRole = await repo.weightsFor(roles.map((r) => r.id));
    const weightsOf = (id: string) => weightsByRole.get(id) ?? DEFAULT_COMPOSITE_WEIGHTS;
    const sheets = roles.map((role) => resultsSheet(role.name, attempts.filter((a) => a.candidate.jobRoleId === role.id), flags, weightsOf(role.id)));
    return { roleName: jobRoleId ? roles[0]!.name : null, sheets: sheets.length > 0 ? sheets : [resultsSheet('Results', [], flags, DEFAULT_COMPOSITE_WEIGHTS)] };
  }

  async function activityExport(jobRoleId: string | undefined): Promise<{ roleName: string | null; sheets: SheetSpec[] }> {
    const roles = await rolesFor(jobRoleId);
    const attempts = await repo.liveAttempts(roles.map((r) => r.id));
    const flags = await deps.getFlagsBatch(attempts.map((a) => a.candidate.id));
    const nearbyIds = [...flags.values()].flatMap((f) => f.location.flatMap((l) => (l.code === 'NEARBY_CANDIDATES' ? l.withCandidateIds : [])));
    const codes = await repo.codesFor([...new Set(nearbyIds)]);

    const describe = (f: CandidateFlags): string | null =>
      f.location
        .map((l) => {
          switch (l.code) {
            case 'LOGIN_START_DISTANCE':
              return `Exam started ${l.km} km from the login location`;
            case 'NEARBY_CANDIDATES':
              return `Started within ${l.meters} m of ${l.withCandidateIds.map((id) => codes.get(id) ?? 'another candidate').join(', ')}`;
            case 'SHARED_IP':
              return `${l.count} candidates started from IP ${l.ip}`;
          }
        })
        .join('\n') || null;

    const sheet = (name: string, rows: LiveAttemptRow[]): SheetSpec => ({
      name,
      columns: [
        { header: 'Candidate code', width: 18 },
        { header: 'Name', width: 28 },
        { header: 'Email', width: 30 },
        { header: 'Status' },
        { header: 'Attempt status' },
        { header: 'Started at', width: 20 },
        { header: 'Submitted at', width: 20 },
        { header: 'Paste/copy attempts' },
        { header: 'Bulk inserts' },
        { header: 'Tab switches' },
        { header: 'Window blurs' },
        { header: 'IP changes' },
        { header: 'Location flags' },
        { header: 'Location findings', width: 60 },
        { header: 'Flag score' },
      ],
      rows: rows.map((a): Cell[] => {
        const f = flags.get(a.candidate.id) ?? EMPTY_FLAGS;
        return [
          a.candidate.candidateCode,
          a.candidate.fullName,
          a.candidate.email,
          a.candidate.status,
          a.status,
          a.startedAt,
          a.submittedAt,
          f.integrity.pasteAttempts,
          f.integrity.bulkInsert,
          f.integrity.tabHidden,
          f.integrity.blur,
          f.integrity.ipChanges,
          f.location.length,
          describe(f),
          flagScore(f),
        ];
      }),
    });
    const sheets = roles.map((role) => sheet(role.name, attempts.filter((a) => a.candidate.jobRoleId === role.id)));
    return { roleName: jobRoleId ? roles[0]!.name : null, sheets: sheets.length > 0 ? sheets : [sheet('Activity', [])] };
  }

  return { decide, decideMany, leaderboard, dashboard, resultsExport, activityExport };
}

export type ResultsService = ReturnType<typeof createResultsService>;
