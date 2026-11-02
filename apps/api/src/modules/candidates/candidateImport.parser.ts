// modules/candidates/candidateImport.parser.ts
// Pure row validation for the candidate import: no I/O, so the preview is built
// (and unit-tested) from parsed rows plus the existing accounts. Row numbers are
// the source line (header = 1); callers pass them from readSheet so blank
// interior rows do not shift them, and index+2 is the fallback. A person may
// hold several applications (one per job role, docs/multi-exam.md): a duplicate
// is the same email in the same role, in the file or in the DB, and is reported
// apart from errors and skipped. The same email under another role is valid and
// listed in `linkedRows` (it attaches to the existing account); a mobile that
// belongs to a different account is an error there. Unmapped columns are kept
// in `extra`. With `updateExisting`, a row whose email already holds this role as
// a not-yet-started application becomes an update instead (blank cells keep the
// stored value), so a corrected file can be uploaded again.

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

/** An existing candidate to update (matched by email + role); null fields mean "keep the stored value". */
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
  /** Rows of `valid` that attach to an existing account under a new role. */
  linkedRows: number[];
}

/** An existing sign-in account, with the roles it already holds. */
export interface ExistingAccount {
  accountId: string;
  mobile: string | null;
  /** jobRoleId -> the application for that role. */
  roles: Map<string, { id: string; status: string }>;
}

export interface ParseContext {
  defaultJobRoleId: string;
  rolesByLowerName: Map<string, string>;
  /** Existing accounts by lower-cased email. */
  accountsByEmail: Map<string, ExistingAccount>;
  /** Account id owning each stored mobile. */
  mobileOwners: Map<string, string>;
  /** Update mode: rows for an existing email + role update that application instead of being skipped. */
  updateExisting?: boolean;
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
  const out: ParsedCandidates = { valid: [], errors: [], duplicates: [], updates: [], linkedRows: [] };
  const seenKeys = new Set<string>();
  const mobileEmail = new Map<string, string>();

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

    const key = `${email}|${jobRoleId}`;
    const account = ctx.accountsByEmail.get(email);
    const held = account?.roles.get(jobRoleId);
    const owner = mobile !== null ? ctx.mobileOwners.get(mobile) : undefined;

    if (account && held) {
      if (!ctx.updateExisting) {
        out.duplicates.push({ row, reason: 'EXISTS' });
        return;
      }
      if (seenKeys.has(key)) {
        out.duplicates.push({ row, reason: 'IN_FILE' });
        return;
      }
      if (held.status !== 'NOT_STARTED') {
        out.errors.push({ row, field: 'email', message: 'This candidate has already started an exam and cannot be updated by import' });
        return;
      }
      if (owner !== undefined && owner !== account.accountId) {
        out.errors.push({ row, field: 'mobile', message: 'This mobile belongs to another candidate' });
        return;
      }
      seenKeys.add(key);
      if (mobile !== null) mobileEmail.set(mobile, email);
      out.updates.push({
        row,
        candidateId: held.id,
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

    if (seenKeys.has(key) || (mobile !== null && mobileEmail.has(mobile) && mobileEmail.get(mobile) !== email)) {
      out.duplicates.push({ row, reason: 'IN_FILE' });
      return;
    }
    if (account) {
      if (owner !== undefined && owner !== account.accountId) {
        out.errors.push({ row, field: 'mobile', message: 'This mobile belongs to another candidate' });
        return;
      }
    } else if (owner !== undefined) {
      out.duplicates.push({ row, reason: 'EXISTS' });
      return;
    }
    seenKeys.add(key);
    if (mobile !== null) mobileEmail.set(mobile, email);
    if (account) out.linkedRows.push(row);

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
