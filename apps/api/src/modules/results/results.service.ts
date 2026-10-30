// modules/results/results.service.ts
// Super Admin outcomes (design §8, §9): the shortlist/reject decision (only
// after an evaluation, with history and audit), the per-role leaderboard
// (total marks desc, ties by earlier submit), the dashboard counts every admin
// sees (numbers only, so nothing here is blind-marking sensitive), and the two
// XLSX exports. Marks, totals and comments are exported only once an
// evaluation is submitted; a draft or reopened one is work in progress.

import type { DashboardRoleDto, DecisionInput, LeaderboardRowDto } from '@exam/shared';
import { conflict, notFound } from '../../shared/errors.js';
import type { CandidateFlags } from '../exam/index.js';
import { flagBreakdown, flagScore } from '../exam/index.js';
import { num, toCandidatePii } from '../evaluation/index.js';
import type { Cell, SheetSpec } from './exports.js';
import type { CandidateStatusValue, LiveAttemptRow, ResultsRepository, ScoredAttempt } from './results.repository.js';

export interface ResultsDeps {
  repo: ResultsRepository;
  getFlagsBatch: (candidateIds: string[]) => Promise<Map<string, CandidateFlags>>;
}

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

export function createResultsService(deps: ResultsDeps) {
  const { repo } = deps;

  async function decide(candidateId: string, input: DecisionInput, actor: Actor): Promise<{ candidateId: string; status: string }> {
    const comment = input.comment ? input.comment : null;
    const r = await repo.decide(candidateId, input.decision, actor.id, comment, (from) => ({
      adminId: actor.id,
      action: 'CANDIDATE_DECISION',
      entity: 'candidate',
      entityId: candidateId,
      metadata: { from, to: input.decision, comment },
      ip: actor.ip,
    }));
    if ('refused' in r) {
      if (r.refused === 'NOT_FOUND') throw notFound('Candidate not found');
      throw conflict(
        r.from === input.decision
          ? `The candidate is already ${input.decision.toLowerCase()}`
          : 'A decision can only be made after the evaluation is submitted',
      );
    }
    return { candidateId, status: input.decision };
  }

  async function leaderboard(jobRoleId: string): Promise<{ items: LeaderboardRowDto[] }> {
    const rows = await repo.leaderboard(jobRoleId);
    const flags = await deps.getFlagsBatch(rows.map((r) => r.candidate.id));
    return {
      items: rows.map((r, i) => ({
        rank: i + 1,
        candidateCode: r.candidate.candidateCode,
        ...toCandidatePii(r.candidate),
        status: r.candidate.status,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        totalMarks: num(r.totalMarks) ?? 0,
        maxMarks: num(r.maxMarks) ?? 0,
        percentage: num(r.percentage) ?? 0,
        questionMarks: r.questions.map((q) => ({ order: q.order, marks: num(q.evaluation?.marks ?? null), maxMarks: num(q.maxMarksSnapshot) ?? 0 })),
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
          (dto[STATUS_KEYS[c.status]] as number) += c.count;
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

  function resultsSheet(roleName: string, rows: ScoredAttempt[], flags: Map<string, CandidateFlags>): SheetSpec {
    const qCount = Math.max(0, ...rows.flatMap((r) => r.questions.map((q) => q.order)));
    const orders = Array.from({ length: qCount }, (_, i) => i + 1);
    let rank = 0;
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
        { header: 'Evaluation' },
        { header: 'Submitted at', width: 20 },
        { header: 'Submit type' },
        { header: 'Time taken (min)' },
        ...orders.map((o) => ({ header: `Q${o} marks` })),
        { header: 'Total' },
        { header: 'Max' },
        { header: 'Percentage' },
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
          r.evaluation?.status ?? 'PENDING',
          r.submittedAt,
          r.submitType,
          minutes(r.startedAt, r.submittedAt),
          ...orders.map((o) => (evaluated ? num(byOrder.get(o)?.evaluation?.marks ?? null) : null)),
          evaluated ? num(r.totalMarks) : null,
          evaluated ? num(r.maxMarks) : null,
          evaluated ? num(r.percentage) : null,
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
    const sheets = roles.map((role) => resultsSheet(role.name, attempts.filter((a) => a.candidate.jobRoleId === role.id), flags));
    return { roleName: jobRoleId ? roles[0]!.name : null, sheets: sheets.length > 0 ? sheets : [resultsSheet('Results', [], flags)] };
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

  return { decide, leaderboard, dashboard, resultsExport, activityExport };
}

export type ResultsService = ReturnType<typeof createResultsService>;
