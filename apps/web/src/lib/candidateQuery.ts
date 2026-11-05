// src/lib/candidateQuery.ts
// Why: the Candidates list filters as one value and its query string, shared by the
// list and "select all matching" (which must ask for exactly the same rows). Pure so
// it is unit tested. Min boxes are strings: '' means off, '0' is a real minimum.

import type { CandidateExamStatsDto } from '@exam/shared';

export type CandidateSort = 'fullName' | 'majorCpi' | 'xPercentage' | 'xiiPercentage' | 'createdAt' | 'timeTaken' | 'marks';

export interface CandidateFilters {
  search: string;
  jobRoleId: string;
  status: string;
  result: '' | 'SHORTLISTED' | 'REJECTED' | 'NONE';
  flagged: '' | 'true' | 'false';
  xMin: string;
  xiiMin: string;
  cpiMin: string;
  marksPctMin: string;
  sort: CandidateSort;
  dir: 'asc' | 'desc';
}

export const EMPTY_CANDIDATE_FILTERS: CandidateFilters = {
  search: '',
  jobRoleId: '',
  status: '',
  result: '',
  flagged: '',
  xMin: '',
  xiiMin: '',
  cpiMin: '',
  marksPctMin: '',
  sort: 'createdAt',
  dir: 'desc',
};

/** The filter keys that count toward "Clear filters". */
export const FILTER_KEYS = ['search', 'jobRoleId', 'status', 'result', 'flagged', 'xMin', 'xiiMin', 'cpiMin', 'marksPctMin'] as const;

export function candidateQuery(f: CandidateFilters, page?: number, pageSize?: number): URLSearchParams {
  const q = new URLSearchParams({ sort: f.sort, dir: f.dir });
  if (page !== undefined) q.set('page', String(page));
  if (pageSize !== undefined) q.set('pageSize', String(pageSize));
  for (const key of FILTER_KEYS) {
    const v = f[key].trim();
    if (v !== '') q.set(key, v);
  }
  return q;
}

/** "38 / 50 (76%)", or "-" until the evaluation is submitted. */
export function marksText(e: CandidateExamStatsDto | null): string {
  if (!e || e.totalMarks === null || e.percentage === null) return '-';
  return `${e.totalMarks} / ${e.maxMarks} (${e.percentage}%)`;
}
