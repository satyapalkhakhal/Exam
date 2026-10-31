// modules/candidates/candidateImport.parser.ts
// Pure row validation for the candidate import: no I/O, so the preview is built
// (and unit-tested) from parsed rows plus the existing emails/mobiles. Row
// numbers are the source line (header = 1); callers pass them from readSheet so
// blank interior rows do not shift them, and index+2 is the fallback. Duplicates
// (email or mobile, in the file or in the DB) are reported apart from errors and
// skipped. Unmapped columns are kept in `extra`. With `updateExisting`, a row whose
// email belongs to a not-yet-started candidate becomes an update instead (moved to the
// row's job profile; blank cells keep the stored value), so a file uploaded to the wrong
// job profile can be corrected by uploading it again.

import { CANDIDATE_NAME_MAX, CANDIDATE_TEXT_MAX, normalizeMobile } from '@exam/shared';

export interface CandidateDraft {
  row: number;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  majorCpi: number | null;
  discipline: string | null;
  programme: string | null;
  jobRoleId: string;
  extra: Record<string, string>;
}

export interface RowError {
  row: number;
  field: string;
  message: string;
}

export interface RowDuplicate {
  row: number;
  reason: 'IN_FILE' | 'EXISTS';
}

/** An existing candidate to update; null fields mean "keep the stored value". */
export interface CandidateUpdateDraft {
  row: number;
  candidateId: string;
  email: string;
  fullName: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: number | null;
  xiiPercentage: number | null;
  majorCpi: number | null;
  discipline: string | null;
  programme: string | null;
  jobRoleId: string;
}

export interface ParsedCandidates {
  valid: CandidateDraft[];
  errors: RowError[];
  duplicates: RowDuplicate[];
  updates: CandidateUpdateDraft[];
}

export interface ParseContext {
  defaultJobRoleId: string;
  rolesByLowerName: Map<string, string>;
  existingEmails: Set<string>;
  existingMobiles: Set<string>;
  /** Update mode: rows for existing emails update those candidates instead of being skipped. */
  updateExisting?: boolean;
  /** Update mode only: existing candidates by lower-cased email. */
  existingByEmail?: Map<string, { id: string; status: string; mobile: string | null }>;
  /** Update mode only: candidate id owning each stored mobile. */
  mobileOwners?: Map<string, string>;
}

export const HEADER_MAP = {
  name: 'fullName',
  email: 'email',
  mobile: 'mobile',
  roll_number: 'rollNumber',
  'schooling.x_percentage': 'xPercentage',
  'schooling.xii_percentage': 'xiiPercentage',
  major_cpi: 'majorCpi',
  'major.discipline': 'discipline',
  'major.programme': 'programme',
  job_role: 'jobRoleName',
} as const;

export const TEMPLATE_COLUMNS = [
  'schooling.x_percentage',
  'schooling.xii_percentage',
  'roll_number',
  'name',
  'major_cpi',
  'major.discipline',
  'major.programme',
  'email',
  'mobile',
  'job_role',
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseDecimal(raw: string, max: number): number | null | undefined {
  if (raw === '') return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > max ? undefined : n;
}

export function parseCandidateRows(
  rows: Record<string, string>[],
  ctx: ParseContext,
  rowNumbers?: number[],
): ParsedCandidates {
  const out: ParsedCandidates = { valid: [], errors: [], duplicates: [], updates: [] };
  const seenEmails = new Set<string>();
  const seenMobiles = new Set<string>();

  rows.forEach((r, i) => {
    const row = rowNumbers?.[i] ?? i + 2;
    const errs: RowError[] = [];
    const err = (field: string, message: string) => errs.push({ row, field, message });

    const fullName = (r.name ?? '').trim();
    if (fullName.length < 2 || fullName.length > CANDIDATE_NAME_MAX) err('name', `Name must be 2 to ${CANDIDATE_NAME_MAX} characters`);

    const email = (r.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) err('email', 'A valid email is required');

    const mobileRaw = (r.mobile ?? '').trim();
    let mobile: string | null = null;
    if (mobileRaw !== '') {
      mobile = normalizeMobile(mobileRaw);
      if (mobile === null) err('mobile', 'Mobile must be a 10-digit Indian number starting 6-9');
    }

    const num = (col: string, max: number, label: string): number | null => {
      const v = parseDecimal((r[col] ?? '').trim(), max);
      if (v === undefined) {
        err(col, `${label} must be a number from 0 to ${max}`);
        return null;
      }
      return v;
    };
    const xPercentage = num('schooling.x_percentage', 100, 'X percentage');
    const xiiPercentage = num('schooling.xii_percentage', 100, 'XII percentage');
    const majorCpi = num('major_cpi', 10, 'CPI');

    const text = (col: string): string | null => {
      const v = (r[col] ?? '').trim();
      return v === '' ? null : v;
    };
    for (const col of ['roll_number', 'major.discipline', 'major.programme']) {
      if ((text(col)?.length ?? 0) > CANDIDATE_TEXT_MAX) err(col, `Must be at most ${CANDIDATE_TEXT_MAX} characters`);
    }

    let jobRoleId = ctx.defaultJobRoleId;
    const roleName = (r.job_role ?? '').trim();
    if (roleName !== '') {
      const id = ctx.rolesByLowerName.get(roleName.toLowerCase());
      if (id) jobRoleId = id;
      else err('job_role', `Unknown job role "${roleName}"`);
    }

    if (errs.length > 0) {
      out.errors.push(...errs);
      return;
    }

    const current = ctx.updateExisting ? ctx.existingByEmail?.get(email) : undefined;
    if (current) {
      if (seenEmails.has(email) || (mobile !== null && seenMobiles.has(mobile))) {
        out.duplicates.push({ row, reason: 'IN_FILE' });
        return;
      }
      if (current.status !== 'NOT_STARTED') {
        out.errors.push({ row, field: 'email', message: 'This candidate has already started an exam and cannot be updated by import' });
        return;
      }
      const owner = mobile !== null ? ctx.mobileOwners?.get(mobile) : undefined;
      if (owner !== undefined && owner !== current.id) {
        out.errors.push({ row, field: 'mobile', message: 'This mobile belongs to another candidate' });
        return;
      }
      seenEmails.add(email);
      if (mobile !== null) seenMobiles.add(mobile);
      out.updates.push({
        row,
        candidateId: current.id,
        email,
        fullName,
        mobile,
        rollNumber: text('roll_number'),
        xPercentage,
        xiiPercentage,
        majorCpi,
        discipline: text('major.discipline'),
        programme: text('major.programme'),
        jobRoleId,
      });
      return;
    }

    if (ctx.existingEmails.has(email) || (mobile !== null && ctx.existingMobiles.has(mobile))) {
      out.duplicates.push({ row, reason: 'EXISTS' });
      return;
    }
    if (seenEmails.has(email) || (mobile !== null && seenMobiles.has(mobile))) {
      out.duplicates.push({ row, reason: 'IN_FILE' });
      return;
    }
    seenEmails.add(email);
    if (mobile !== null) seenMobiles.add(mobile);

    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!(k in HEADER_MAP) && v.trim() !== '') extra[k] = v.trim();
    }

    out.valid.push({
      row,
      fullName,
      email,
      mobile,
      rollNumber: text('roll_number'),
      xPercentage,
      xiiPercentage,
      majorCpi,
      discipline: text('major.discipline'),
      programme: text('major.programme'),
      jobRoleId,
      extra,
    });
  });

  return out;
}
