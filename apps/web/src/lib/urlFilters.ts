// src/lib/urlFilters.ts
// Why: the campus dashboard (spec 2026-11-11) links to Candidates and Submissions with its
// filters in the URL. A page reads them once, as its starting filters, through these
// validators only: an unknown key, or a value that is not a valid id / programme / round /
// batch, is ignored, so a hand-edited link can never send junk (or a blind-marking-breaking
// college filter for an Evaluator: the caller drops those validators) to the API.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Validator = (v: string) => boolean;

export const LINK_FILTER_VALIDATORS = {
  collegeId: (v: string) => UUID.test(v),
  jobRoleId: (v: string) => UUID.test(v),
  batch: (v: string) => v.trim().length > 0 && v.trim().length <= 60,
  jobProfileType: (v: string) => v === 'PLACEMENT' || v === 'INTERNSHIP',
  roundNumber: (v: string) => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 20,
} satisfies Record<string, Validator>;

/** `empty` with every key that has a validator and a valid value in `search` filled in. */
export function filtersFromSearch<T extends object>(search: string, empty: T, validators: Partial<Record<keyof T, Validator>>): T {
  const q = new URLSearchParams(search);
  const out = { ...empty } as Record<string, unknown>;
  for (const [key, valid] of Object.entries(validators) as [string, Validator | undefined][]) {
    if (!(key in empty) || !valid) continue;
    const v = q.get(key);
    if (v !== null && valid(v)) out[key] = v.trim();
  }
  return out as T;
}

/** "IITG · Nov 2026 · Round 1 · Internship" for the "From dashboard" chip. */
export function linkedFilterLabel(f: { collegeName?: string; batch?: string; roundNumber?: string; jobProfileType?: string }): string {
  return [
    f.collegeName,
    f.batch,
    f.roundNumber ? `Round ${f.roundNumber}` : '',
    f.jobProfileType === 'INTERNSHIP' ? 'Internship' : f.jobProfileType === 'PLACEMENT' ? 'Placement' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
