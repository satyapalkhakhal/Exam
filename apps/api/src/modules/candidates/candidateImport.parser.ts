// modules/candidates/candidateImport.parser.ts
// Pure row validation for the candidate import: no I/O, so the preview is built
// (and unit-tested) from parsed rows plus the existing emails/mobiles. Row
// numbers are the source line (header = 1); callers pass them from readSheet so
// blank interior rows do not shift them, and index+2 is the fallback. Unmapped
// columns are kept in `extra`.
// Each row registers one person (by email) for one exam (the optional `exam`
// column, else the chosen one). Outcomes (spec 5.2):
// - new: unknown email -> a new person, their registration and Round 1 entry;
// - addToExisting: the email is a person already (in the DB, or an earlier row
//   of this file) not yet registered for that exam -> registration only; the
//   person's profile is never changed by the file (the first row's wins);
// - duplicate: that person is already registered for that exam (EXISTS in the
//   DB, IN_FILE earlier in this file) -> skipped;
// - error: the row's mobile belongs to a different person than its email.

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
  examId: string;
  kind: 'new' | 'addToExisting';
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

export interface ParsedCandidates {
  valid: CandidateDraft[];
  errors: RowError[];
  duplicates: RowDuplicate[];
}

export interface ExamRef {
  id: string;
  active: boolean;
  /** Registering needs the exam's first round to exist. */
  hasRounds: boolean;
}

export interface ExistingPerson {
  id: string;
  mobile: string | null;
  examIds: Set<string>;
}

export interface ParseContext {
  defaultExamId: string;
  /** Every exam by trimmed, lower-cased name (names are unique). */
  examsByLowerName: Map<string, ExamRef>;
  /** Existing people by lower-cased email. */
  peopleByEmail: Map<string, ExistingPerson>;
  personIdByMobile: Map<string, string>;
}

export const MOBILE_TAKEN = 'mobile belongs to another candidate';

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
  exam: 'examName',
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
  'exam',
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
  const out: ParsedCandidates = { valid: [], errors: [], duplicates: [] };
  // People first seen in this file (new emails): their mobile and exams so far.
  const filePeople = new Map<string, { mobile: string | null; examIds: Set<string> }>();
  const fileMobileOwner = new Map<string, string>();
  // Exams already taken by rows of this file for existing people.
  const fileExamsOfExisting = new Map<string, Set<string>>();

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

    let examId = ctx.defaultExamId;
    const examName = (r.exam ?? '').trim();
    if (examName !== '') {
      const exam = ctx.examsByLowerName.get(examName.toLowerCase());
      if (!exam || !exam.active) err('exam', `Unknown or inactive exam "${examName}"`);
      else if (!exam.hasRounds) err('exam', `The exam "${examName}" has no rounds yet`);
      else examId = exam.id;
    }

    if (errs.length > 0) {
      out.errors.push(...errs);
      return;
    }

    const existing = ctx.peopleByEmail.get(email);
    const known = existing ?? filePeople.get(email);
    const mobileOwnerId = mobile === null ? undefined : ctx.personIdByMobile.get(mobile);
    const mobileFileOwner = mobile === null ? undefined : fileMobileOwner.get(mobile);
    let kind: CandidateDraft['kind'];

    if (existing) {
      if (existing.examIds.has(examId)) {
        out.duplicates.push({ row, reason: 'EXISTS' });
        return;
      }
      const taken = fileExamsOfExisting.get(email) ?? new Set<string>();
      if (taken.has(examId)) {
        out.duplicates.push({ row, reason: 'IN_FILE' });
        return;
      }
      if ((mobileOwnerId !== undefined && mobileOwnerId !== existing.id) || mobileFileOwner !== undefined) {
        err('mobile', MOBILE_TAKEN);
      } else {
        taken.add(examId);
        fileExamsOfExisting.set(email, taken);
        kind = 'addToExisting';
      }
    } else if (known) {
      if (known.examIds.has(examId)) {
        out.duplicates.push({ row, reason: 'IN_FILE' });
        return;
      }
      if (mobileOwnerId !== undefined || (mobileFileOwner !== undefined && mobileFileOwner !== email)) {
        err('mobile', MOBILE_TAKEN);
      } else {
        known.examIds.add(examId);
        kind = 'addToExisting';
      }
    } else if (mobileOwnerId !== undefined || mobileFileOwner !== undefined) {
      err('mobile', MOBILE_TAKEN);
    } else {
      filePeople.set(email, { mobile, examIds: new Set([examId]) });
      if (mobile !== null) fileMobileOwner.set(mobile, email);
      kind = 'new';
    }

    if (errs.length > 0) {
      out.errors.push(...errs);
      return;
    }

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
      examId,
      kind: kind!,
      extra,
    });
  });

  return out;
}
