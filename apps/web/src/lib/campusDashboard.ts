// src/lib/campusDashboard.ts
// Why: the Super Admin's campus hiring dashboard (spec 2026-11-11) is built from one per-drive
// payload (tens of drives), so every filter, total, funnel stage, average, ranking and the CSV
// are worked out here, pure and unit tested; the page only renders. Definitions (spec §5):
// - Round filter defaults to Round 1, so a candidate promoted to Round 2 (a second application)
//   is not counted twice.
// - Submitted / Evaluated are "reached this stage"; Pending = Submitted − Evaluated.
// - Selection % = Selected ÷ (Selected + Rejected); Avg. exam % = Σ% ÷ count, weighted across drives.

import type { DashboardDriveDto, JobProfileType } from '@exam/shared';

export interface DashFilters {
  batch: string;
  collegeId: string;
  jobRoleId: string;
  programme: '' | JobProfileType;
  /** '' = all rounds. */
  roundNumber: string;
}

export const DEFAULT_DASH_FILTERS: DashFilters = { batch: '', collegeId: '', jobRoleId: '', programme: '', roundNumber: '1' };

/** Performance tag thresholds on the average exam % (spec §8; the reference's values). */
export const PERFORMANCE_THRESHOLDS = { strong: 84, good: 78 } as const;
export type PerformanceTag = 'Strong' | 'Good' | 'Needs review';

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
/** Batches compare like the list endpoints (case-insensitive equals), trimmed (review M-1). */
const batchKey = (b: string | null | undefined) => (b ?? '').trim().toLowerCase();
const byName = (a: string, b: string) => a.localeCompare(b);
/** Descending, nulls last. */
const descNullsLast = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);

// ---- filters ------------------------------------------------------------------------

export function filterOptions(rows: readonly DashboardDriveDto[]) {
  const colleges = new Map<string, string>();
  const profiles = new Map<string, string>();
  for (const r of rows) {
    if (r.collegeId) colleges.set(r.collegeId, r.collegeName ?? r.collegeShortCode ?? '');
    profiles.set(r.jobRoleId, r.jobRoleName);
  }
  const named = (m: Map<string, string>) => [...m].map(([id, name]) => ({ id, name })).sort((a, b) => byName(a.name, b.name));
  return {
    // One option per batch whatever its spelling: the first spelling seen.
    batches: [...new Map(rows.filter((r) => r.batch).map((r) => [batchKey(r.batch), r.batch!] as const).reverse()).values()].sort(byName),
    colleges: named(colleges),
    profiles: named(profiles),
    rounds: [...new Set(rows.map((r) => r.roundNumber))].sort((a, b) => a - b),
  };
}

export function applyFilters(rows: readonly DashboardDriveDto[], f: DashFilters): DashboardDriveDto[] {
  return rows.filter(
    (r) =>
      (!f.batch || batchKey(r.batch) === batchKey(f.batch)) &&
      (!f.collegeId || r.collegeId === f.collegeId) &&
      (!f.jobRoleId || r.jobRoleId === f.jobRoleId) &&
      (!f.programme || r.jobProfileType === f.programme) &&
      (!f.roundNumber || String(r.roundNumber) === f.roundNumber),
  );
}

// ---- totals -------------------------------------------------------------------------

export interface Totals {
  applications: number;
  notStarted: number;
  inProgress: number;
  /** Reached "submitted": submitted, auto-submitted, evaluated and decided. */
  submitted: number;
  /** Reached "evaluated": evaluated and decided (a decision needs an evaluation). */
  evaluated: number;
  pending: number;
  selected: number;
  rejected: number;
  examPctSum: number;
  examPctCount: number;
}

export function totals(rows: readonly DashboardDriveDto[]): Totals {
  const t: Totals = { applications: 0, notStarted: 0, inProgress: 0, submitted: 0, evaluated: 0, pending: 0, selected: 0, rejected: 0, examPctSum: 0, examPctCount: 0 };
  for (const r of rows) {
    const evaluated = r.evaluated + r.shortlisted + r.rejected;
    const submitted = r.submitted + r.autoSubmitted + evaluated;
    t.applications += r.imported;
    t.notStarted += r.notStarted;
    t.inProgress += r.inProgress;
    t.submitted += submitted;
    t.evaluated += evaluated;
    t.selected += r.shortlisted;
    t.rejected += r.rejected;
    t.examPctSum += r.examPctSum ?? 0;
    t.examPctCount += r.examPctCount ?? 0;
  }
  t.pending = t.submitted - t.evaluated;
  return t;
}

export const avgExamPct = (t: Pick<Totals, 'examPctSum' | 'examPctCount'>): number | null =>
  t.examPctCount > 0 ? round(t.examPctSum / t.examPctCount, 2) : null;

export const selectionPct = (t: Pick<Totals, 'selected' | 'rejected'>): number | null =>
  t.selected + t.rejected > 0 ? round((t.selected / (t.selected + t.rejected)) * 100, 1) : null;

export function performanceTag(avg: number | null): PerformanceTag | null {
  if (avg === null) return null;
  return avg >= PERFORMANCE_THRESHOLDS.strong ? 'Strong' : avg >= PERFORMANCE_THRESHOLDS.good ? 'Good' : 'Needs review';
}

/** Groups rows by key, keeping the first row of each group as its sample. */
function groupBy<K extends string>(rows: readonly DashboardDriveDto[], key: (r: DashboardDriveDto) => K) {
  const out = new Map<K, { sample: DashboardDriveDto; rows: DashboardDriveDto[] }>();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k);
    if (g) g.rows.push(r);
    else out.set(k, { sample: r, rows: [r] });
  }
  return [...out.values()];
}
const collegeName = (r: DashboardDriveDto) => r.collegeName ?? r.collegeShortCode ?? '';

// ---- sections -----------------------------------------------------------------------

/** Applications per institution, largest first (institutions without applications left out). */
export function byInstitution(rows: readonly DashboardDriveDto[]) {
  return groupBy(rows, (r) => r.collegeId ?? '')
    .map((g) => ({ collegeId: g.sample.collegeId ?? '', name: collegeName(g.sample), applications: totals(g.rows).applications }))
    .filter((x) => x.applications > 0)
    .sort((a, b) => b.applications - a.applications || byName(a.name, b.name));
}

/** Institutions with at least one application (drives the "one institution" note). */
export const institutionCount = (rows: readonly DashboardDriveDto[]) => byInstitution(rows).length;

export function institutionProfileMatrix(rows: readonly DashboardDriveDto[]) {
  const profiles = [...new Set(rows.map((r) => r.jobRoleName))].sort(byName);
  const out = groupBy(rows, (r) => `${r.collegeId}|${r.jobProfileType}`)
    .map((g) => {
      const perProfile = profiles.map((p) => totals(g.rows.filter((r) => r.jobRoleName === p)).applications);
      return { name: collegeName(g.sample), programme: g.sample.jobProfileType, perProfile, total: perProfile.reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => byName(a.name, b.name) || byName(a.programme, b.programme));
  return { profiles, rows: out };
}

const statusOf = (t: Totals) => ({
  applications: t.applications,
  notStarted: t.notStarted,
  inProgress: t.inProgress,
  submitted: t.submitted,
  pending: t.pending,
  evaluated: t.evaluated,
  selected: t.selected,
  rejected: t.rejected,
});

export function institutionStatusRows(rows: readonly DashboardDriveDto[]) {
  return groupBy(rows, (r) => `${r.collegeId}|${r.jobProfileType}`)
    .map((g) => ({ name: collegeName(g.sample), programme: g.sample.jobProfileType, ...statusOf(totals(g.rows)) }))
    .sort((a, b) => byName(a.name, b.name) || byName(a.programme, b.programme));
}

export function profileRows(rows: readonly DashboardDriveDto[]) {
  return groupBy(rows, (r) => `${r.jobRoleId}|${r.collegeId}|${r.jobProfileType}`)
    .map((g) => {
      const t = totals(g.rows);
      return {
        profile: g.sample.jobRoleName,
        institution: collegeName(g.sample),
        programme: g.sample.jobProfileType,
        applications: t.applications,
        avgExamPct: avgExamPct(t),
        selected: t.selected,
        rejected: t.rejected,
        selectionPct: selectionPct(t),
      };
    })
    .sort((a, b) => byName(a.profile, b.profile) || descNullsLast(a.avgExamPct, b.avgExamPct) || byName(a.institution, b.institution));
}

export function internshipRows(rows: readonly DashboardDriveDto[]) {
  return groupBy(
    rows.filter((r) => r.jobProfileType === 'INTERNSHIP'),
    (r) => `${r.collegeId}|${r.jobRoleId}`,
  )
    .map((g) => {
      const t = totals(g.rows);
      return { institution: collegeName(g.sample), profile: g.sample.jobRoleName, ...statusOf(t), selectionPct: selectionPct(t) };
    })
    .sort((a, b) => byName(a.institution, b.institution) || byName(a.profile, b.profile));
}

/**
 * Institutions ranked within each job profile × programme × round (never across role families,
 * nor across rounds: each round is a different paper, review M-2): by average exam %, then
 * selection %, then name; rows without an evaluated candidate last.
 */
export function rankingGroups(rows: readonly DashboardDriveDto[]) {
  return groupBy(rows, (r) => `${r.jobRoleId}|${r.jobProfileType}|${r.roundNumber}`)
    .map((g) => {
      const items = groupBy(g.rows, (r) => r.collegeId ?? '')
        .map((c) => {
          const t = totals(c.rows);
          const avg = avgExamPct(t);
          return { name: collegeName(c.sample), applications: t.applications, avgExamPct: avg, selectionPct: selectionPct(t), selected: t.selected, tag: performanceTag(avg) };
        })
        .sort((a, b) => descNullsLast(a.avgExamPct, b.avgExamPct) || descNullsLast(a.selectionPct, b.selectionPct) || byName(a.name, b.name))
        .map((x, i) => ({ rank: i + 1, ...x }));
      return { profile: g.sample.jobRoleName, programme: g.sample.jobProfileType, roundNumber: g.sample.roundNumber, items };
    })
    .sort((a, b) => byName(a.profile, b.profile) || byName(a.programme, b.programme) || a.roundNumber - b.roundNumber);
}

// ---- export and links ---------------------------------------------------------------

/** Every cell quoted; a text cell starting with = + - @ (or tab / CR) is prefixed with ' so a spreadsheet never runs it. */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

function linkQuery(f: DashFilters): string {
  const q = new URLSearchParams();
  if (f.collegeId) q.set('collegeId', f.collegeId);
  if (f.batch) q.set('batch', f.batch);
  if (f.jobRoleId) q.set('jobRoleId', f.jobRoleId);
  if (f.programme) q.set('jobProfileType', f.programme);
  if (f.roundNumber) q.set('roundNumber', f.roundNumber);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const candidatesLink = (f: DashFilters) => `/admin/candidates${linkQuery(f)}`;
export const submissionsLink = (f: DashFilters) => `/admin/submissions${linkQuery(f)}`;

/**
 * "Comparisons appear once more colleges take the exam": only when the data itself has one
 * college. Picking one institution in the filter is not that (review M-4).
 */
export const showOneInstitutionNote = (f: DashFilters, rows: readonly DashboardDriveDto[]): boolean => !f.collegeId && institutionCount(rows) === 1;
