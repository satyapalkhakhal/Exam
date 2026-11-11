// modules/results/results.service.ts
// Super Admin outcomes (design §8, §9): the shortlist/reject decision (only
// after an evaluation, with history and audit), the per-drive leaderboard
// (spec 2026-11-10: one college's drive of one round; total marks desc, ties by
// earlier submit; or by composite / AI % on request), AI marks and the weighted
// composite with the round's weights (docs/ai-evaluation.md §7, §10), the
// dashboard counts (per drive for a Super Admin; per round, without college or
// batch, for an Evaluator: blind marking), and the two XLSX exports (a sheet per
// drive). Marks, totals and comments are exported only once an
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
  DashboardDriveDto,
  DecisionInput,
  EmailSendInput,
  EmailSendResultDto,
  LeaderboardRowDto,
} from '@exam/shared';
import { JOB_PROFILE_TYPE_LABELS } from '@exam/shared';
import { conflict, notFound } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger/logger.js';
import type { CandidateFlags } from '../exam/index.js';
import { flagBreakdown, flagScore } from '../exam/index.js';
import { combinedTotals, num, percentageOf, toCandidatePii } from '../evaluation/index.js';
import type { Cell, SheetSpec } from './exports.js';
import { displayNameOf, type CandidateStatusValue, type DriveFilter, type LiveAttemptRow, type ResultDrive, type ResultsRepository, type ScoredAttempt } from './results.repository.js';

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

const EMPTY_FLAGS: CandidateFlags = { integrity: { pasteAttempts: 0, bulkInsert: 0, tabHidden: 0, blur: 0, ipChanges: 0 }, location: [], nearbyCount: null };

const STATUS_KEYS: Record<CandidateStatusValue, keyof DashboardDriveDto> = {
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

type ScoredQuestion = ScoredAttempt['questions'][number];
/** Written questions only: MCQs are auto-marked, never AI-graded nor marked per question. */
export const writtenOf = (r: ScoredAttempt): ScoredQuestion[] => r.questions.filter((q) => q.typeSnapshot !== 'MCQ');

/**
 * AI % (written questions only, when every one has a DONE AI score) and the
 * composite. The exam % in the composite is the human percentage once the
 * evaluation is submitted, else (provisional) the MCQ subtotal plus the AI
 * written marks over the full maximum, once every written question is AI-scored.
 */
export function scoreRow(r: ScoredAttempt, weights: CompositeWeights): RowScores {
  const written = writtenOf(r);
  const aiMarksByOrder = new Map<number, number>();
  for (const q of written) {
    const m = num(q.aiScores[0]?.marks ?? null);
    if (m !== null) aiMarksByOrder.set(q.order, m);
  }
  const allScored = aiMarksByOrder.size === written.length;
  const aiSum = [...aiMarksByOrder.values()].reduce((a, b) => a + b, 0);
  const aiMax = written.reduce((a, q) => a + (num(q.maxMarksSnapshot) ?? 0), 0);
  const aiPercentage = written.length > 0 && allScored ? percentageOf(aiSum, aiMax) : null;
  const mcqMax = num(r.mcqMaxMarks) ?? 0;
  const provisionalExam = allScored && (written.length > 0 || mcqMax > 0) ? combinedTotals(aiSum, aiMax, num(r.mcqMarks), mcqMax).percentage : null;
  const human = r.evaluation?.status === 'SUBMITTED' ? num(r.percentage) : null;
  const exam = human ?? provisionalExam;
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

  async function leaderboard(driveId: string, sort: LeaderboardSort = 'human'): Promise<{ items: LeaderboardRowDto[] }> {
    const [rows, drives] = await Promise.all([repo.leaderboard(driveId, sort !== 'human'), repo.drives({ driveId })]);
    if (!drives[0]) throw notFound('Drive not found');
    const weights = drives[0].weights;
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
        mcqMarks: num(r.mcqMarks),
        mcqMaxMarks: num(r.mcqMaxMarks) ?? 0,
        questionMarks: writtenOf(r).map((q) => ({
          order: q.order,
          marks: r.evaluation?.status === 'SUBMITTED' ? num(q.evaluation?.marks ?? null) : null,
          aiMarks: s.aiMarksByOrder.get(q.order) ?? null,
          maxMarks: num(q.maxMarksSnapshot) ?? 0,
        })),
        aiPercentage: s.aiPercentage,
        compositeScore: s.composite,
        compositeProvisional: s.provisional,
        flagCounts: flagBreakdown(flags.get(r.candidate.id) ?? EMPTY_FLAGS),
        nearbyCount: (flags.get(r.candidate.id) ?? EMPTY_FLAGS).nearbyCount,
      })),
    };
  }

  /**
   * Counts per drive for a Super Admin. An Evaluator gets one row per round
   * (its drives summed) with no drive, college or batch: blind marking.
   */
  async function dashboard(viewer: 'SUPER_ADMIN' | 'EVALUATOR' = 'SUPER_ADMIN'): Promise<{ drives: DashboardDriveDto[] }> {
    const blind = viewer !== 'SUPER_ADMIN';
    const [drives, counts, stats] = await Promise.all([repo.drives({}), repo.statusCounts(), blind ? Promise.resolve([]) : repo.examPercentStats()]);
    const statOf = new Map(stats.map((s) => [s.driveId, s]));
    const rows = new Map<string, DashboardDriveDto>();
    const rowFor = new Map<string, DashboardDriveDto>();
    for (const d of drives) {
      const key = blind ? d.roundId : d.id;
      const dto: DashboardDriveDto = rows.get(key) ?? {
          driveId: blind ? null : d.id,
          displayName: blind ? `${d.jobRoleName} · Round ${d.roundNumber}` : displayNameOf(d),
          jobRoleId: d.jobRoleId,
          jobRoleName: d.jobRoleName,
          jobProfileType: d.jobProfileType,
          roundNumber: d.roundNumber,
          collegeShortCode: blind ? null : d.collegeShortCode,
          batch: blind ? null : d.batch,
          refApplicantCount: d.refApplicantCount,
          imported: 0,
          notStarted: 0,
          inProgress: 0,
          submitted: 0,
          autoSubmitted: 0,
          evaluated: 0,
          shortlisted: 0,
          rejected: 0,
          pendingEvaluation: 0,
          // Campus dashboard (spec 2026-11-11): the college and exam % reach a Super Admin only.
          ...(blind
            ? {}
            : { collegeId: d.collegeId, collegeName: d.collegeName, roundId: d.roundId, examPctSum: statOf.get(d.id)?.sum ?? 0, examPctCount: statOf.get(d.id)?.count ?? 0 }),
        };
      rows.set(key, dto);
      rowFor.set(d.id, dto);
    }
    for (const c of counts) {
      const dto = rowFor.get(c.driveId);
      if (!dto) continue;
      dto.imported += c.count;
      // A decided candidate counts under its result, not under "evaluated" (awaiting a decision).
      if (c.result) (dto[STATUS_KEYS[c.result]] as number) += c.count;
      else (dto[STATUS_KEYS[c.status]] as number) += c.count;
    }
    for (const dto of rows.values()) dto.pendingEvaluation = dto.submitted + dto.autoSubmitted;
    return { drives: [...rows.values()] };
  }

  /** Drives for an export; a filter that matches nothing is a 404. */
  async function drivesFor(filter: DriveFilter): Promise<ResultDrive[]> {
    const drives = await repo.drives(filter);
    if (Object.values(filter).some(Boolean) && drives.length === 0) throw notFound('Nothing matches this filter');
    return drives;
  }

  /** File name label: the drive, else the job profile, else "all". */
  const labelOf = (filter: DriveFilter, drives: ResultDrive[]): string | null =>
    filter.driveId && drives[0] ? displayNameOf(drives[0]) : filter.jobRoleId && drives[0] ? drives[0].jobRoleName : null;

  const DRIVE_COLUMNS = [{ header: 'Job profile', width: 24 }, { header: 'Type' }, { header: 'Round', width: 8 }, { header: 'College' }, { header: 'Batch', width: 16 }];
  const driveCells = (d: ResultDrive): Cell[] => [d.jobRoleName, JOB_PROFILE_TYPE_LABELS[d.jobProfileType], d.roundNumber, d.collegeShortCode, d.batch];

  function resultsSheet(drive: ResultDrive | null, rows: ScoredAttempt[], flags: Map<string, CandidateFlags>): SheetSpec {
    const weights: CompositeWeights = drive?.weights ?? DEFAULT_COMPOSITE_WEIGHTS;
    // Per-question columns for written questions only (by the order the candidate saw them).
    const orders = [...new Set(rows.flatMap((r) => writtenOf(r).map((q) => q.order)))].sort((a, b) => a - b);
    let rank = 0;
    const weightsText = `${weights.exam}/${weights.x}/${weights.xii}/${weights.cpi}`;
    return {
      name: drive ? displayNameOf(drive) : 'Results',
      columns: [
        { header: 'Rank', width: 6 },
        { header: 'Candidate code', width: 18 },
        ...DRIVE_COLUMNS,
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
        { header: 'MCQ marks' },
        { header: 'MCQ max' },
        { header: 'MCQ correct' },
        { header: 'MCQ wrong' },
        { header: 'MCQ unanswered' },
        ...orders.map((o) => ({ header: `Q${o} AI marks` })),
        { header: 'AI %' },
        { header: 'Composite' },
        { header: 'Composite basis' },
        { header: 'Weights (exam/X/XII/CPI)' },
        ...FLAG_COLUMNS.map((f) => ({ header: f.header })),
        { header: 'Nearby candidates' },
        { header: 'Flag score' },
        { header: 'Evaluator comments', width: 60 },
      ],
      rows: rows.map((r): Cell[] => {
        const c = r.candidate;
        const evaluated = r.evaluation?.status === 'SUBMITTED' && r.totalMarks !== null;
        const f = flags.get(c.id) ?? EMPTY_FLAGS;
        const breakdown = flagBreakdown(f);
        const byOrder = new Map(writtenOf(r).map((q) => [q.order, q]));
        const sc = scoreRow(r, weights);
        // MCQ marks are automatic (set at submit), so they are exported whatever the evaluation state.
        const mcqs = r.questions.filter((q) => q.typeSnapshot === 'MCQ');
        const picked = mcqs.filter((q) => q.answer?.selectedOption != null);
        const right = picked.filter((q) => q.answer!.selectedOption === q.correctSnapshot).length;
        const mcqCells: Cell[] =
          mcqs.length === 0 ? [null, null, null, null, null] : [num(r.mcqMarks), num(r.mcqMaxMarks), right, picked.length - right, mcqs.length - picked.length];
        return [
          evaluated ? ++rank : null,
          c.candidateCode,
          ...(drive ? driveCells(drive) : [null, null, null, null, null]),
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
          ...mcqCells,
          ...orders.map((o) => sc.aiMarksByOrder.get(o) ?? null),
          sc.aiPercentage,
          sc.composite,
          sc.composite === null ? null : sc.provisional ? 'AI (provisional)' : 'Human',
          weightsText,
          ...FLAG_COLUMNS.map((col) => breakdown[col.key]),
          f.nearbyCount,
          flagScore(f),
          r.questions
            .filter((q) => evaluated && q.evaluation?.comment)
            .map((q) => `Q${q.order}: ${q.evaluation!.comment}`)
            .join('\n') || null,
        ];
      }),
    };
  }

  async function resultsExport(filter: DriveFilter): Promise<{ label: string | null; sheets: SheetSpec[] }> {
    const drives = await drivesFor(filter);
    const attempts = await repo.submittedAttempts(drives.map((d) => d.id));
    const flags = await deps.getFlagsBatch(attempts.map((a) => a.candidate.id));
    const sheets = drives.map((d) => resultsSheet(d, attempts.filter((a) => a.candidate.driveId === d.id), flags));
    return { label: labelOf(filter, drives), sheets: sheets.length > 0 ? sheets : [resultsSheet(null, [], flags)] };
  }

  async function activityExport(filter: DriveFilter): Promise<{ label: string | null; sheets: SheetSpec[] }> {
    const drives = await drivesFor(filter);
    const attempts = await repo.liveAttempts(drives.map((d) => d.id));
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
    const sheets = drives.map((d) => sheet(displayNameOf(d), attempts.filter((a) => a.candidate.driveId === d.id)));
    return { label: labelOf(filter, drives), sheets: sheets.length > 0 ? sheets : [sheet('Activity', [])] };
  }

  return { decide, decideMany, leaderboard, dashboard, resultsExport, activityExport };
}

export type ResultsService = ReturnType<typeof createResultsService>;
