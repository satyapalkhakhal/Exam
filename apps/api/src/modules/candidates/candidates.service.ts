// modules/candidates/candidates.service.ts
// Candidate import and management (design §6, docs/multi-exam.md). A candidate
// row is one entry (account x drive; spec 2026-11-10: job profile -> round ->
// college drive); email and mobile belong to the account. A person can't hold
// entries in two colleges' drives of the same round and batch (checked under
// the account row lock). Import is two steps like the
// questions: preview parses and caches the valid drafts in Redis (30 min, bound
// to the uploading admin); confirm mints codes from the sequence and inserts
// them with the ImportBatch and audit row in one transaction (an email that
// already has an account gets a new application on it). Disabling a
// candidate or resetting an attempt revokes the account's sessions at once. PII (names,
// emails, mobiles) is never copied into audit metadata.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  CandidateDetailDto,
  CandidateDetailQuery,
  CandidateExamStatsDto,
  CandidateFlagsDto,
  CandidateImportRow,
  CandidateListItemDto,
  CandidateListQuery,
  CandidateMatchingIdsDto,
  CandidateMoveResultDto,
  CandidateMoveToDriveInput,
  CandidateRowDto,
  CandidateCreateInput,
  CandidateUpdateInput,
  ImportConfirmInput,
  ImportPreviewDto,
  ImportResultDto,
  Paginated,
} from '@exam/shared';
import { CANDIDATE_BULK_MAX, driveDisplayName } from '@exam/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { sha256 } from '../../shared/utils/hash.js';
import { maskEmail, maskMobile } from '../../shared/utils/piiMask.js';
import { readSheet } from '../../shared/utils/spreadsheet.js';
import type { AuditRecord } from '../audit/index.js';
import { nextCandidateCodes } from './candidateCode.js';
import {
  parseCandidateRows,
  TEMPLATE_COLUMNS,
  type CandidateDraft,
  type CandidateUpdateDraft,
  type ExistingAccount,
  type ParsedCandidates,
} from './candidateImport.parser.js';

/** Profile fields an import update may change (null in the file = keep the stored value). */
export const UPDATE_FIELDS = [
  'fullName',
  'mobile',
  'rollNumber',
  'xPercentage',
  'xiiPercentage',
  'majorCpi',
  'discipline',
  'programme',
] as const;

type Num = { toNumber(): number } | number | null;

export interface CandidateRow {
  id: string;
  accountId: string;
  candidateCode: string;
  fullName: string;
  email: string;
  mobile: string | null;
  rollNumber: string | null;
  xPercentage: Num;
  xiiPercentage: Num;
  majorCpi: Num;
  discipline: string | null;
  programme: string | null;
  jobRoleId: string;
  driveId: string;
  jobRole: { name: string; type: CandidateRowDto['jobProfileType'] };
  drive: { batch: string; roundId: string; round: { roundNumber: number }; college: { shortCode: string } };
  status: CandidateRowDto['status'];
  result: CandidateRowDto['result'];
  eligible: boolean;
  locationExempt: boolean;
  extra: unknown;
  createdAt: Date;
}

export interface ListExamRow {
  startedAt: Date;
  submittedAt: Date | null;
  totalMarks: Num;
  maxMarks: Num;
  percentage: Num;
  /** The evaluation is SUBMITTED: only then are marks shown. */
  evaluated: boolean;
  answeredCount: number;
  questionCount: number;
}

export interface ListSiblingRow {
  id: string;
  driveDisplayName: string;
  status: CandidateRowDto['status'];
  result: CandidateRowDto['result'];
}

export interface CandidateDetailRows {
  candidate: CandidateRow;
  loginLogs: {
    id: string; stage: 'LOGIN' | 'EXAM_START'; createdAt: Date; permission: string; latitude: Num; longitude: Num;
    accuracyM: number | null; ip: string; browser: string; os: string; deviceType: string;
  }[];
  attempt: { id: string; status: string; startedAt: Date; submittedAt: Date | null } | null;
  otherApplications: { id: string; candidateCode: string; status: string; result: CandidateRowDto['result']; jobRole: { id: string; name: string }; driveDisplayName: string }[];
  activity: { rows: { id: string; eventType: string; createdAt: Date; metadata: unknown }[]; total: number };
  history: {
    id: string; fromStatus: string | null; toStatus: string; fromResult: CandidateRowDto['result']; toResult: CandidateRowDto['result'];
    comment: string | null; createdAt: Date; byAdmin: { name: string } | null;
  }[];
}

export interface ImportCommit {
  driveId: string;
  jobRoleId: string;
  /** Update mode: existing entries of the drive to refresh (null field = keep stored value). */
  updates: CandidateUpdateDraft[];
  /** One CANDIDATE_UPDATED audit row per candidate actually updated. */
  updateAudit: (u: CandidateUpdateDraft) => AuditRecord;
  fileName: string;
  fileHash: string;
  uploadedById: string;
  total: number;
  rows: (CandidateDraft & { candidateCode: string })[];
  errors: unknown[];
  audit: (n: { imported: number; updated: number }) => AuditRecord;
}

/** `driveId` changes carry the target drive's job role along (always written together). */
export type CandidateChanges = Partial<Omit<CandidateUpdateInput, 'mobile'>> & { mobile?: string | null; jobRoleId?: string };

/** A drive as the candidates module needs it. */
export interface DriveTarget {
  id: string;
  jobRoleId: string;
  roundId: string;
  active: boolean;
}

export interface CandidatesRepository {
  findDrive(id: string): Promise<DriveTarget | null>;
  /** Accounts with their entries relative to `driveId` (entries by drive, plus any same-round-and-batch sibling entry). */
  existingAccounts(driveId: string): Promise<{ accountsByEmail: Map<string, ExistingAccount>; mobileOwners: Map<string, string> }>;
  lastImportOf(driveId: string, fileHash: string): Promise<Date | null>;
  /**
   * Creates the new rows and applies the updates in one transaction. Rows whose
   * person meanwhile got an entry in a sibling drive (same round + batch) are
   * skipped, checked under the account row locks.
   */
  confirmImport(input: ImportCommit): Promise<{ imported: number; updated: number }>;
  /** Attaches to the account that owns the email (or creates it). Throws CONFLICT when the person is already in the drive, in a sibling drive (SAME_ROUND_BATCH), or the mobile belongs to another account. */
  create(data: CandidateCreateInput & { candidateCode: string; jobRoleId: string }, audit: (id: string) => AuditRecord): Promise<CandidateRow>;
  /** Candidates matching the filters (flagged ignored) that could carry a review flag. */
  possiblyFlaggedIds(query: CandidateListQuery): Promise<string[]>;
  /** `ids` further restricts the rows (the flagged filter, resolved by the service). */
  list(query: CandidateListQuery, ids?: { in: string[] } | { notIn: string[] }): Promise<{ rows: CandidateRow[]; total: number }>;
  /** Current attempt stats per candidate id, and every application per account id (the caller drops the row itself). */
  listExtras(rows: { id: string; accountId: string }[]): Promise<{ exams: Map<string, ListExamRow>; others: Map<string, ListSiblingRow[]> }>;
  /** Ids matching the filters; rows is empty when total exceeds CANDIDATE_BULK_MAX. */
  matchingIds(query: CandidateListQuery, ids?: { in: string[] } | { notIn: string[] }): Promise<{ total: number; rows: { id: string; driveId: string }[] }>;
  detail(id: string, activitySkip: number, activityTake: number): Promise<CandidateDetailRows | null>;
  findById(id: string): Promise<CandidateRow | null>;
  /** Email and mobile changes go to the account (and every entry's copy). Throws CONFLICT on a clash with another account, an entry already in the target drive, or a sibling drive (SAME_ROUND_BATCH). */
  update(id: string, data: CandidateChanges, audit: AuditRecord): Promise<CandidateRow>;
  setEligible(id: string, eligible: boolean, audit: AuditRecord): Promise<CandidateRow>;
  /**
   * One transaction: locks the accounts then the candidates (id order) and moves
   * each one into the target drive unless: already there (or the person already
   * has an entry there) → SAME_DRIVE; the target is another round and the
   * candidate has started → STARTED; the person has an entry in another college's
   * drive of the target's round and batch → SAME_ROUND_BATCH. One audit row per move.
   */
  moveToDrive(
    ids: string[],
    target: DriveTarget,
    audit: (candidateId: string, fromDriveId: string) => AuditRecord,
  ): Promise<CandidateMoveResultDto>;
  setLocationExempt(id: string, exempt: boolean, audit: AuditRecord): Promise<CandidateRow>;
  /** One transaction; returns false when the candidate has no live attempt. */
  resetAttempt(id: string, adminId: string, reason: string, audit: AuditRecord): Promise<boolean>;
}

interface CachedPreview extends ParsedCandidates {
  adminId: string;
  driveId: string;
  jobRoleId: string;
  fileName: string;
  fileHash: string;
  total: number;
}

export const PREVIEW_TTL_SECONDS = 30 * 60;
export const ACTIVITY_PAGE_SIZE = 50;
export const previewKey = (id: string): string => `exam:import:${id}`;
const ENTITY = 'candidate';

const num = (n: Num): number | null => (n === null ? null : typeof n === 'number' ? n : n.toNumber());

/** Email and mobile leave the API masked; the full values only through revealContact (audited). */
export const toRowDto = (r: CandidateRow): CandidateRowDto => ({
  id: r.id,
  candidateCode: r.candidateCode,
  fullName: r.fullName,
  email: maskEmail(r.email),
  mobile: r.mobile ? maskMobile(r.mobile) : null,
  rollNumber: r.rollNumber,
  xPercentage: num(r.xPercentage),
  xiiPercentage: num(r.xiiPercentage),
  majorCpi: num(r.majorCpi),
  discipline: r.discipline,
  programme: r.programme,
  jobRoleId: r.jobRoleId,
  jobRoleName: r.jobRole.name,
  jobProfileType: r.jobRole.type,
  driveId: r.driveId,
  driveDisplayName: driveDisplayName({
    jobRoleName: r.jobRole.name,
    roundNumber: r.drive.round.roundNumber,
    collegeShortCode: r.drive.college.shortCode,
    batch: r.drive.batch,
  }),
  roundNumber: r.drive.round.roundNumber,
  collegeShortCode: r.drive.college.shortCode,
  status: r.status,
  result: r.result,
  eligible: r.eligible,
  locationExempt: r.locationExempt,
  flagCount: 0,
  createdAt: r.createdAt.toISOString(),
});

const toExamStats = (a: ListExamRow | undefined): CandidateExamStatsDto | null =>
  a
    ? {
        startedAt: a.startedAt.toISOString(),
        submittedAt: a.submittedAt?.toISOString() ?? null,
        answeredCount: a.answeredCount,
        questionCount: a.questionCount,
        totalMarks: a.evaluated ? num(a.totalMarks) : null,
        maxMarks: num(a.maxMarks) ?? 0,
        percentage: a.evaluated ? num(a.percentage) : null,
      }
    : null;

export interface CandidatesDeps {
  redis: () => Redis;
  /** Revokes every session of the candidate account. */
  revokeSessions: (accountId: string) => Promise<void>;
  /** The exam module's flag score per candidate. */
  flagCounts: (candidateIds: string[]) => Promise<Map<string, number>>;
  /** Flag score and nearby-candidates count per candidate (one flags pass, for a list page). */
  flagSummary: (candidateIds: string[]) => Promise<Map<string, { score: number; nearbyCount: number | null }>>;
  /** The exam module's flags for one candidate, and their score. */
  getFlags: (candidateId: string) => Promise<CandidateFlagsDto>;
  flagScore: (flags: CandidateFlagsDto) => number;
  audit: (entry: AuditRecord) => Promise<void>;
}

export function createCandidatesService(repo: CandidatesRepository, deps: CandidatesDeps) {
  async function flaggedRestriction(query: CandidateListQuery): Promise<{ in: string[] } | { notIn: string[] } | undefined> {
    if (query.flagged === undefined) return undefined;
    const candidates = await repo.possiblyFlaggedIds(query);
    const scores = await deps.flagCounts(candidates);
    const flagged = candidates.filter((id) => (scores.get(id) ?? 0) > 0);
    return query.flagged ? { in: flagged } : { notIn: flagged };
  }

  async function list(query: CandidateListQuery): Promise<Paginated<CandidateListItemDto>> {
    const { rows, total } = await repo.list(query, await flaggedRestriction(query));
    const [summary, extras] = await Promise.all([deps.flagSummary(rows.map((r) => r.id)), repo.listExtras(rows)]);
    return {
      items: rows.map((r) => ({
        ...toRowDto(r),
        flagCount: summary.get(r.id)?.score ?? 0,
        nearbyCount: summary.get(r.id)?.nearbyCount ?? null,
        exam: toExamStats(extras.exams.get(r.id)),
        otherApplications: (extras.others.get(r.accountId) ?? [])
          .filter((o) => o.id !== r.id)
          .map((o) => ({ driveDisplayName: o.driveDisplayName, status: o.status, result: o.result })),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Every matching id, for "select all matching" on the list. */
  async function matchingIds(query: CandidateListQuery): Promise<CandidateMatchingIdsDto> {
    const { total, rows } = await repo.matchingIds(query, await flaggedRestriction(query));
    if (total > CANDIDATE_BULK_MAX) throw badRequest(`More than ${CANDIDATE_BULK_MAX} candidates match. Narrow the filters.`);
    return { ids: rows.map((r) => r.id), total, driveIdById: Object.fromEntries(rows.map((r) => [r.id, r.driveId])) };
  }

  async function detail(id: string, query: CandidateDetailQuery): Promise<CandidateDetailDto> {
    const d = await repo.detail(id, (query.activityPage - 1) * ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE);
    if (!d) throw notFound('Candidate not found');
    const flags = await deps.getFlags(id);
    return {
      candidate: { ...toRowDto(d.candidate), flagCount: deps.flagScore(flags), extra: (d.candidate.extra ?? {}) as Record<string, string> },
      loginLogs: d.loginLogs.map((l) => ({
        id: l.id,
        kind: l.stage === 'EXAM_START' ? 'START' : 'LOGIN',
        createdAt: l.createdAt.toISOString(),
        permission: l.permission,
        latitude: num(l.latitude),
        longitude: num(l.longitude),
        accuracyM: l.accuracyM,
        ip: l.ip,
        browser: l.browser,
        os: l.os,
        deviceType: l.deviceType,
      })),
      otherApplications: d.otherApplications.map((o) => ({
        id: o.id, candidateCode: o.candidateCode, jobRole: o.jobRole, driveDisplayName: o.driveDisplayName, status: o.status, result: o.result,
      })),
      attempt: d.attempt
        ? {
            id: d.attempt.id,
            status: d.attempt.status,
            startedAt: d.attempt.startedAt.toISOString(),
            submittedAt: d.attempt.submittedAt?.toISOString() ?? null,
          }
        : null,
      activity: {
        items: d.activity.rows.map((a) => ({ id: a.id, type: a.eventType, createdAt: a.createdAt.toISOString(), detail: a.metadata })),
        total: d.activity.total,
        page: query.activityPage,
        pageSize: ACTIVITY_PAGE_SIZE,
      },
      flags,
      history: d.history.map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        fromResult: h.fromResult,
        toResult: h.toResult,
        reason: h.comment,
        actorName: h.byAdmin?.name ?? null,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  /** The target drive, or 404 / 409 when it is unknown or inactive. */
  async function usableDrive(driveId: string): Promise<DriveTarget> {
    const drive = await repo.findDrive(driveId);
    if (!drive) throw notFound('Drive not found');
    if (!drive.active) throw conflict('This drive is inactive. Activate it first.');
    return drive;
  }

  async function create(input: CandidateCreateInput, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    const drive = await usableDrive(input.driveId);
    const [candidateCode] = await nextCandidateCodes(1);
    const row = await repo.create({ ...input, candidateCode: candidateCode!, jobRoleId: drive.jobRoleId }, (id) => ({
      adminId: actorId,
      action: 'CANDIDATE_CREATED',
      entity: ENTITY,
      entityId: id,
      metadata: { driveId: input.driveId },
      ip,
    }));
    return toRowDto(row);
  }

  async function update(id: string, input: CandidateUpdateInput, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    const existing = await repo.findById(id);
    if (!existing) throw notFound('Candidate not found');
    let changes: CandidateChanges = input;
    if (input.driveId !== undefined && input.driveId !== existing.driveId) {
      const target = await usableDrive(input.driveId);
      // Same round = same questions: a started candidate may move (wrong college fixed).
      if (target.roundId !== existing.drive.roundId && existing.status !== 'NOT_STARTED') {
        throw new AppError(409, 'ROLE_CHANGE_FORBIDDEN', 'Once the candidate has started, they can only move to a drive of the same round');
      }
      changes = { ...input, jobRoleId: target.jobRoleId };
    }
    const row = await repo.update(id, changes, {
      adminId: actorId,
      action: 'CANDIDATE_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: { fields: Object.keys(input).filter((k) => input[k as keyof CandidateUpdateInput] !== undefined) },
      ip,
    });
    return toRowDto(row);
  }

  async function moveToDrive(input: CandidateMoveToDriveInput, actorId: string, ip: string | null): Promise<CandidateMoveResultDto> {
    const target = await usableDrive(input.driveId);
    return repo.moveToDrive(input.candidateIds, target, (candidateId, fromDriveId) => ({
      adminId: actorId,
      action: 'CANDIDATE_MOVED',
      entity: ENTITY,
      entityId: candidateId,
      metadata: { via: 'bulk', fromDriveId, toDriveId: input.driveId },
      ip,
    }));
  }

  /** The full email and mobile of one candidate (the Show button), audited without copying them. */
  async function revealContact(id: string, actorId: string, ip: string | null): Promise<{ email: string; mobile: string | null }> {
    const row = await repo.findById(id);
    if (!row) throw notFound('Candidate not found');
    await deps.audit({ adminId: actorId, action: 'CANDIDATE_CONTACT_REVEALED', entity: ENTITY, entityId: id, metadata: {}, ip });
    return { email: row.email, mobile: row.mobile };
  }

  async function setEligibility(id: string, eligible: boolean, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    const found = await repo.findById(id);
    if (!found) throw notFound('Candidate not found');
    const row = await repo.setEligible(id, eligible, {
      adminId: actorId,
      action: eligible ? 'CANDIDATE_ENABLED' : 'CANDIDATE_DISABLED',
      entity: ENTITY,
      entityId: id,
      metadata: {},
      ip,
    });
    if (!eligible) await deps.revokeSessions(found.accountId);
    return toRowDto(row);
  }

  async function setLocationExempt(id: string, exempt: boolean, reason: string, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    const row = await repo.setLocationExempt(id, exempt, {
      adminId: actorId,
      action: exempt ? 'CANDIDATE_LOCATION_EXEMPTED' : 'CANDIDATE_LOCATION_EXEMPTION_REMOVED',
      entity: ENTITY,
      entityId: id,
      metadata: { reason },
      ip,
    });
    return toRowDto(row);
  }

  async function resetAttempt(id: string, reason: string, actorId: string, ip: string | null): Promise<{ status: 'NOT_STARTED' }> {
    const found = await repo.findById(id);
    if (!found) throw notFound('Candidate not found');
    const done = await repo.resetAttempt(id, actorId, reason, {
      adminId: actorId,
      action: 'CANDIDATE_ATTEMPT_RESET',
      entity: ENTITY,
      entityId: id,
      metadata: { reason },
      ip,
    });
    if (!done) throw conflict('This candidate has no attempt to reset');
    await deps.revokeSessions(found.accountId);
    return { status: 'NOT_STARTED' };
  }

  async function previewImport(
    file: { buffer: Buffer; originalname: string },
    driveId: string,
    actorId: string,
    updateExisting = false,
  ): Promise<ImportPreviewDto<CandidateImportRow>> {
    const drive = await usableDrive(driveId);
    const sheet = await readSheet(file.buffer, file.originalname);
    const missing = (['name', 'email'] as const).filter((c) => !sheet.headers.includes(c));
    if (missing.length > 0) {
      throw badRequest(`Missing required column: ${missing.join(', ')}. Expected: ${TEMPLATE_COLUMNS.join(', ')}`);
    }
    const existing = await repo.existingAccounts(driveId);
    const parsed = parseCandidateRows(
      sheet.rows,
      {
        driveId,
        jobRoleId: drive.jobRoleId,
        accountsByEmail: existing.accountsByEmail,
        mobileOwners: existing.mobileOwners,
        updateExisting,
      },
      sheet.rowNumbers,
    );
    const previewId = randomUUID();
    const fileHash = sha256(file.buffer.toString('base64'));
    const cached: CachedPreview = { ...parsed, adminId: actorId, driveId, jobRoleId: drive.jobRoleId, fileName: file.originalname, fileHash, total: sheet.rows.length };
    await deps.redis().set(previewKey(previewId), JSON.stringify(cached), 'EX', PREVIEW_TTL_SECONDS);
    return {
      previewId,
      fileHash,
      summary: {
        total: cached.total,
        valid: parsed.valid.length,
        errors: parsed.errors.length,
        duplicates: parsed.duplicates.length,
        ...(updateExisting ? { updates: parsed.updates.length } : {}),
      },
      valid: parsed.valid.map((d) => ({ row: d.row, fullName: d.fullName, email: d.email, mobile: d.mobile, rollNumber: d.rollNumber })),
      errors: parsed.errors,
      duplicates: parsed.duplicates,
      linkedRows: parsed.linkedRows,
      ...(updateExisting
        ? { updates: parsed.updates.map((u) => ({ row: u.row, fullName: u.fullName, email: u.email, mobile: u.mobile, rollNumber: u.rollNumber })) }
        : {}),
    };
  }

  async function confirmImport(input: ImportConfirmInput, actorId: string, ip: string | null): Promise<ImportResultDto> {
    const raw = await deps.redis().get(previewKey(input.previewId));
    if (!raw) throw notFound('This preview has expired. Upload the file again.');
    const cached = JSON.parse(raw) as CachedPreview;
    if (cached.adminId !== actorId) throw forbidden('This preview belongs to another admin');
    await usableDrive(cached.driveId);

    if (!input.force) {
      const previous = await repo.lastImportOf(cached.driveId, cached.fileHash);
      if (previous) throw conflict(`This file was already imported on ${previous.toISOString().slice(0, 10)}`);
    }

    const codes = await nextCandidateCodes(cached.valid.length);
    const updates = cached.updates ?? [];
    const { imported, updated } = await repo.confirmImport({
      driveId: cached.driveId,
      jobRoleId: cached.jobRoleId,
      updates,
      updateAudit: (u) => ({
        adminId: actorId,
        action: 'CANDIDATE_UPDATED',
        entity: ENTITY,
        entityId: u.candidateId,
        metadata: {
          via: 'import',
          fileName: cached.fileName,
          driveId: cached.driveId,
          fields: UPDATE_FIELDS.filter((k) => u[k] !== null),
        },
        ip,
      }),
      fileName: cached.fileName,
      fileHash: cached.fileHash,
      uploadedById: actorId,
      total: cached.total,
      rows: cached.valid.map((d, i) => ({ ...d, candidateCode: codes[i]! })),
      errors: [...cached.errors, ...cached.duplicates],
      audit: (n) => ({
        adminId: actorId,
        action: 'CANDIDATES_IMPORTED',
        entity: 'drive',
        entityId: cached.driveId,
        metadata: { fileName: cached.fileName, total: cached.total, imported: n.imported, updated: n.updated, forced: input.force === true },
        ip,
      }),
    });
    await deps.redis().del(previewKey(input.previewId));
    return { imported, skipped: cached.total - imported - updated, ...(updates.length > 0 ? { updated } : {}) };
  }

  return { list, matchingIds, revealContact, detail, create, update, moveToDrive, setEligibility, setLocationExempt, resetAttempt, previewImport, confirmImport };
}

export type CandidatesService = ReturnType<typeof createCandidatesService>;
