// modules/candidates/candidates.service.ts
// Candidate import and management (design §6; spec 5.2). A candidate is a
// person; they sit exams through registrations, one round entry per round they
// may sit. The list is one row per round entry. Import is two steps like the
// questions: preview parses and caches the drafts in Redis (30 min, bound to
// the uploading admin); confirm mints codes for new people and inserts people,
// registrations and Round 1 entries with the ImportBatch and audit row in one
// transaction. Disabling a candidate or resetting an attempt revokes their
// sessions at once. PII (names, emails, mobiles) is never copied into audit
// metadata.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  CandidateDetailDto,
  CandidateDetailQuery,
  CandidateFlagsDto,
  CandidateImportRow,
  CandidateListQuery,
  CandidateRegistrationDto,
  CandidateRowDto,
  CandidateCreateInput,
  CandidateStatus,
  CandidateUpdateInput,
  ImportConfirmInput,
  ImportPreviewDto,
  ImportResultDto,
  Paginated,
} from '@exam/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { sha256 } from '../../shared/utils/hash.js';
import { readSheet } from '../../shared/utils/spreadsheet.js';
import type { AuditRecord } from '../audit/index.js';
import { nextCandidateCodes } from './candidateCode.js';
import {
  parseCandidateRows,
  TEMPLATE_COLUMNS,
  type CandidateDraft,
  type ExamRef,
  type ExistingPerson,
  type ParsedCandidates,
} from './candidateImport.parser.js';

type Num = { toNumber(): number } | number | null;

export interface PersonFields {
  id: string;
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
  eligible: boolean;
  locationExempt: boolean;
  extra: unknown;
  createdAt: Date;
}

export interface ExamFields {
  id: string;
  name: string;
  jobRoleId: string;
  jobRole: { name: string };
}

export interface EntryRow {
  id: string;
  status: CandidateStatus;
  round: { id: string; roundNumber: number; name: string | null };
  /** The entry's live (non-RESET) attempt, if any. */
  attempts: { id: string; status: string; startedAt: Date; submittedAt: Date | null }[];
}

export interface RegistrationRow {
  id: string;
  exam: ExamFields;
  entries: EntryRow[];
}

/** A person with every registration (oldest first) and its entries (by round). */
export interface PersonRow extends PersonFields {
  registrations: RegistrationRow[];
}

/** One list row: a round entry with its exam and person. */
export interface ListRow extends EntryRow {
  registration: { exam: ExamFields; candidate: PersonFields };
}

export interface CandidateDetailRows {
  candidate: PersonRow;
  loginLogs: {
    id: string; stage: 'LOGIN' | 'EXAM_START'; createdAt: Date; permission: string; latitude: Num; longitude: Num;
    accuracyM: number | null; ip: string; browser: string; os: string; deviceType: string;
  }[];
  attempt: { id: string; status: string; startedAt: Date; submittedAt: Date | null } | null;
  activity: { rows: { id: string; eventType: string; createdAt: Date; metadata: unknown }[]; total: number };
  history: { id: string; fromStatus: string | null; toStatus: string; comment: string | null; createdAt: Date; byAdmin: { name: string } | null }[];
}

export interface ImportCommit {
  examId: string;
  fileName: string;
  fileHash: string;
  uploadedById: string;
  total: number;
  /** New people carry a minted code; addToExisting rows are matched by email. */
  rows: (CandidateDraft & { candidateCode: string | null })[];
  errors: unknown[];
  audit: (imported: number) => AuditRecord;
}

export type CandidateChanges = Partial<Omit<CandidateUpdateInput, 'mobile'>> & { mobile?: string | null };

export interface ExamForRegistration {
  id: string;
  active: boolean;
  firstRoundId: string | null;
}

export interface EntryCandidate {
  entryId: string;
  candidateId: string;
  attemptId: string | null;
}

export interface CandidatesRepository {
  examForRegistration(id: string): Promise<ExamForRegistration | null>;
  examsByLowerName(): Promise<Map<string, ExamRef>>;
  importContext(): Promise<{ peopleByEmail: Map<string, ExistingPerson>; personIdByMobile: Map<string, string> }>;
  lastImportOf(examId: string, fileHash: string): Promise<Date | null>;
  /** Returns how many registrations were created. */
  confirmImport(input: ImportCommit): Promise<number>;
  findIdByEmail(email: string): Promise<string | null>;
  /** Person + registration + Round 1 entry. Throws CONFLICT when the email or mobile belongs to another candidate, or the exam stopped being usable. */
  create(
    data: Omit<CandidateCreateInput, 'examId'> & { candidateCode: string },
    examId: string,
    adminId: string,
    audit: (id: string) => AuditRecord,
  ): Promise<PersonRow>;
  /** Entries matching the filters (flagged ignored) that could carry a review flag. */
  possiblyFlaggedEntries(query: CandidateListQuery): Promise<EntryCandidate[]>;
  /** `ids` (round entry ids) further restricts the rows (the flagged filter, resolved by the service). */
  list(query: CandidateListQuery, ids?: { in: string[] } | { notIn: string[] }): Promise<{ rows: ListRow[]; total: number }>;
  detail(id: string, activitySkip: number, activityTake: number): Promise<CandidateDetailRows | null>;
  findById(id: string): Promise<PersonRow | null>;
  /** Throws CONFLICT when the email or mobile belongs to another candidate. */
  update(id: string, data: CandidateChanges, audit: AuditRecord): Promise<PersonRow>;
  setEligible(id: string, eligible: boolean, audit: AuditRecord): Promise<PersonRow>;
  setLocationExempt(id: string, exempt: boolean, audit: AuditRecord): Promise<PersonRow>;
  /** Registration + Round 1 entry; throws NOT_FOUND / CONFLICT. */
  register(candidateId: string, examId: string, adminId: string, audit: (registrationId: string) => AuditRecord): Promise<RegistrationRow>;
  /** Throws NOT_FOUND / CONFLICT (started, or the person's last registration). */
  removeRegistration(candidateId: string, registrationId: string, audit: (examId: string) => AuditRecord): Promise<void>;
  /**
   * One transaction: removes the next round's untouched entry (else CONFLICT),
   * marks the entry's live attempt RESET and the entry NOT_STARTED. CONFLICT
   * when the entry has no live attempt; NOT_FOUND when the entry is not the
   * candidate's. Any refusal changes nothing.
   */
  resetAttempt(
    candidateId: string,
    entryId: string,
    adminId: string,
    reason: string,
    audit: (r: { attemptId: string; nextRoundEntry: 'removed' | 'none' }) => AuditRecord,
  ): Promise<void>;
}

interface CachedPreview extends ParsedCandidates {
  adminId: string;
  examId: string;
  fileName: string;
  fileHash: string;
  total: number;
}

export const PREVIEW_TTL_SECONDS = 30 * 60;
export const ACTIVITY_PAGE_SIZE = 50;
export const previewKey = (id: string): string => `exam:import:${id}`;
const ENTITY = 'candidate';
export const EMAIL_TAKEN = 'This email already belongs to a candidate. Add the exam from their page.';
export const EXAM_INACTIVE = 'This exam is not active.';
export const EXAM_HAS_NO_ROUNDS = 'This exam has no rounds yet. Add Round 1 first.';
export const NOTHING_TO_RESET = 'This round has no attempt to reset';

const num = (n: Num): number | null => (n === null ? null : typeof n === 'number' ? n : n.toNumber());

export function toRowDto(p: PersonFields, exam: ExamFields | null, entry: EntryRow | null): CandidateRowDto {
  return {
    id: p.id,
    entryId: entry?.id ?? '',
    examId: exam?.id ?? '',
    examName: exam?.name ?? '',
    roundId: entry?.round.id ?? '',
    roundNumber: entry?.round.roundNumber ?? 0,
    candidateCode: p.candidateCode,
    fullName: p.fullName,
    email: p.email,
    mobile: p.mobile,
    rollNumber: p.rollNumber,
    xPercentage: num(p.xPercentage),
    xiiPercentage: num(p.xiiPercentage),
    majorCpi: num(p.majorCpi),
    discipline: p.discipline,
    programme: p.programme,
    jobRoleId: exam?.jobRoleId ?? '',
    jobRoleName: exam?.jobRole.name ?? '',
    status: entry?.status ?? 'NOT_STARTED',
    eligible: p.eligible,
    locationExempt: p.locationExempt,
    flagCount: 0,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * A person as one row (create/edit/toggle responses, the detail header): their
 * latest registration's furthest round entry. Every person keeps at least one
 * registration; the blanks only guard data that breaks that rule.
 */
export function personDto(p: PersonRow): CandidateRowDto {
  const reg = p.registrations.at(-1) ?? null;
  return toRowDto(p, reg?.exam ?? null, reg?.entries.at(-1) ?? null);
}

const attemptDto = (a: { id: string; status: string; startedAt: Date; submittedAt: Date | null } | null | undefined) =>
  a ? { id: a.id, status: a.status, startedAt: a.startedAt.toISOString(), submittedAt: a.submittedAt?.toISOString() ?? null } : null;

export const registrationDto = (r: RegistrationRow): CandidateRegistrationDto => ({
  registrationId: r.id,
  examId: r.exam.id,
  examName: r.exam.name,
  jobRoleName: r.exam.jobRole.name,
  entries: r.entries.map((e) => ({
    entryId: e.id,
    roundId: e.round.id,
    roundNumber: e.round.roundNumber,
    roundName: e.round.name ?? '',
    status: e.status,
    attempt: attemptDto(e.attempts[0]),
  })),
});

export interface CandidatesDeps {
  redis: () => Redis;
  revokeSessions: (candidateId: string) => Promise<void>;
  /** The exam module's flags per round entry: that entry's attempt's integrity, the person's location. */
  flagsForAttempts: (items: { candidateId: string; attemptId: string | null }[]) => Promise<CandidateFlagsDto[]>;
  /** The exam module's flags for one candidate (person level). */
  getFlags: (candidateId: string) => Promise<CandidateFlagsDto>;
  flagScore: (flags: CandidateFlagsDto) => number;
}

export function createCandidatesService(repo: CandidatesRepository, deps: CandidatesDeps) {
  async function scores(items: { candidateId: string; attemptId: string | null }[]): Promise<number[]> {
    if (items.length === 0) return [];
    return (await deps.flagsForAttempts(items)).map(deps.flagScore);
  }

  /** The exam a new registration goes into: it must exist, be active and have a first round. */
  async function usableExam(examId: string): Promise<ExamForRegistration> {
    const exam = await repo.examForRegistration(examId);
    if (!exam) throw notFound('Exam not found');
    if (!exam.active) throw conflict(EXAM_INACTIVE);
    if (!exam.firstRoundId) throw conflict(EXAM_HAS_NO_ROUNDS);
    return exam;
  }

  async function list(query: CandidateListQuery): Promise<Paginated<CandidateRowDto>> {
    let ids: { in: string[] } | { notIn: string[] } | undefined;
    if (query.flagged !== undefined) {
      const entries = await repo.possiblyFlaggedEntries(query);
      const s = await scores(entries);
      const flagged = entries.filter((_, i) => (s[i] ?? 0) > 0).map((e) => e.entryId);
      ids = query.flagged ? { in: flagged } : { notIn: flagged };
    }
    const { rows, total } = await repo.list(query, ids);
    const s = await scores(rows.map((r) => ({ candidateId: r.registration.candidate.id, attemptId: r.attempts[0]?.id ?? null })));
    return {
      items: rows.map((r, i) => ({ ...toRowDto(r.registration.candidate, r.registration.exam, r), flagCount: s[i] ?? 0 })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async function detail(id: string, query: CandidateDetailQuery): Promise<CandidateDetailDto> {
    const d = await repo.detail(id, (query.activityPage - 1) * ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE);
    if (!d) throw notFound('Candidate not found');
    const flags = await deps.getFlags(id);
    return {
      candidate: { ...personDto(d.candidate), flagCount: deps.flagScore(flags), extra: (d.candidate.extra ?? {}) as Record<string, string> },
      registrations: d.candidate.registrations.map(registrationDto),
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
      attempt: attemptDto(d.attempt),
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
        reason: h.comment,
        actorName: h.byAdmin?.name ?? null,
        createdAt: h.createdAt.toISOString(),
      })),
    };
  }

  async function create(input: CandidateCreateInput, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    const owner = await repo.findIdByEmail(input.email);
    if (owner) throw new AppError(409, 'CONFLICT', EMAIL_TAKEN, { candidateId: owner });
    await usableExam(input.examId);
    const { examId, ...person } = input;
    const [candidateCode] = await nextCandidateCodes(1);
    const row = await repo.create({ ...person, candidateCode: candidateCode! }, examId, actorId, (id) => ({
      adminId: actorId,
      action: 'CANDIDATE_CREATED',
      entity: ENTITY,
      entityId: id,
      metadata: { examId },
      ip,
    }));
    return personDto(row);
  }

  async function update(id: string, input: CandidateUpdateInput, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    const row = await repo.update(id, input, {
      adminId: actorId,
      action: 'CANDIDATE_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: { fields: Object.keys(input).filter((k) => input[k as keyof CandidateUpdateInput] !== undefined) },
      ip,
    });
    return personDto(row);
  }

  async function setEligibility(id: string, eligible: boolean, actorId: string, ip: string | null): Promise<CandidateRowDto> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    const row = await repo.setEligible(id, eligible, {
      adminId: actorId,
      action: eligible ? 'CANDIDATE_ENABLED' : 'CANDIDATE_DISABLED',
      entity: ENTITY,
      entityId: id,
      metadata: {},
      ip,
    });
    if (!eligible) await deps.revokeSessions(id);
    return personDto(row);
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
    return personDto(row);
  }

  async function addRegistration(id: string, examId: string, actorId: string, ip: string | null): Promise<CandidateRegistrationDto> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    await usableExam(examId);
    const reg = await repo.register(id, examId, actorId, (registrationId) => ({
      adminId: actorId,
      action: 'CANDIDATE_REGISTERED',
      entity: ENTITY,
      entityId: id,
      metadata: { examId, registrationId },
      ip,
    }));
    return registrationDto(reg);
  }

  async function removeRegistration(id: string, registrationId: string, actorId: string, ip: string | null): Promise<{ registrationId: string }> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    await repo.removeRegistration(id, registrationId, (examId) => ({
      adminId: actorId,
      action: 'CANDIDATE_REGISTRATION_REMOVED',
      entity: ENTITY,
      entityId: id,
      metadata: { examId, registrationId },
      ip,
    }));
    return { registrationId };
  }

  async function resetAttempt(id: string, entryId: string, reason: string, actorId: string, ip: string | null): Promise<{ status: 'NOT_STARTED' }> {
    if (!(await repo.findById(id))) throw notFound('Candidate not found');
    await repo.resetAttempt(id, entryId, actorId, reason, ({ attemptId, nextRoundEntry }) => ({
      adminId: actorId,
      action: 'CANDIDATE_ATTEMPT_RESET',
      entity: ENTITY,
      entityId: id,
      metadata: { reason, roundEntryId: entryId, attemptId, nextRoundEntry },
      ip,
    }));
    await deps.revokeSessions(id);
    return { status: 'NOT_STARTED' };
  }

  async function previewImport(
    file: { buffer: Buffer; originalname: string },
    examId: string,
    actorId: string,
  ): Promise<ImportPreviewDto<CandidateImportRow>> {
    await usableExam(examId);
    const sheet = await readSheet(file.buffer, file.originalname);
    const missing = (['name', 'email'] as const).filter((c) => !sheet.headers.includes(c));
    if (missing.length > 0) {
      throw badRequest(`Missing required column: ${missing.join(', ')}. Expected: ${TEMPLATE_COLUMNS.join(', ')}`);
    }
    const parsed = parseCandidateRows(
      sheet.rows,
      { defaultExamId: examId, examsByLowerName: await repo.examsByLowerName(), ...(await repo.importContext()) },
      sheet.rowNumbers,
    );
    const previewId = randomUUID();
    const fileHash = sha256(file.buffer.toString('base64'));
    const cached: CachedPreview = { ...parsed, adminId: actorId, examId, fileName: file.originalname, fileHash, total: sheet.rows.length };
    await deps.redis().set(previewKey(previewId), JSON.stringify(cached), 'EX', PREVIEW_TTL_SECONDS);
    return {
      previewId,
      fileHash,
      summary: {
        total: cached.total,
        valid: parsed.valid.length,
        errors: parsed.errors.length,
        duplicates: parsed.duplicates.length,
        addedToExisting: parsed.valid.filter((d) => d.kind === 'addToExisting').length,
      },
      valid: parsed.valid.map((d) => ({ row: d.row, fullName: d.fullName, email: d.email, mobile: d.mobile, rollNumber: d.rollNumber })),
      errors: parsed.errors,
      duplicates: parsed.duplicates,
    };
  }

  async function confirmImport(input: ImportConfirmInput, actorId: string, ip: string | null): Promise<ImportResultDto> {
    const raw = await deps.redis().get(previewKey(input.previewId));
    if (!raw) throw notFound('This preview has expired. Upload the file again.');
    const cached = JSON.parse(raw) as CachedPreview;
    if (cached.adminId !== actorId) throw forbidden('This preview belongs to another admin');
    if (!cached.examId) throw notFound('This preview has expired. Upload the file again.');
    await usableExam(cached.examId);

    if (!input.force) {
      const previous = await repo.lastImportOf(cached.examId, cached.fileHash);
      if (previous) throw conflict(`This file was already imported on ${previous.toISOString().slice(0, 10)}`);
    }

    const fresh = cached.valid.filter((d) => d.kind === 'new');
    const codes = await nextCandidateCodes(fresh.length);
    const codeOf = new Map(fresh.map((d, i) => [d.row, codes[i]!]));
    const addedToExisting = cached.valid.length - fresh.length;
    const imported = await repo.confirmImport({
      examId: cached.examId,
      fileName: cached.fileName,
      fileHash: cached.fileHash,
      uploadedById: actorId,
      total: cached.total,
      rows: cached.valid.map((d) => ({ ...d, candidateCode: codeOf.get(d.row) ?? null })),
      errors: [...cached.errors, ...cached.duplicates],
      audit: (n) => ({
        adminId: actorId,
        action: 'CANDIDATES_IMPORTED',
        entity: 'exam',
        entityId: cached.examId,
        metadata: { fileName: cached.fileName, total: cached.total, imported: n, addedToExisting, forced: input.force === true },
        ip,
      }),
    });
    await deps.redis().del(previewKey(input.previewId));
    return { imported, skipped: cached.total - imported };
  }

  return {
    list,
    detail,
    create,
    update,
    setEligibility,
    setLocationExempt,
    addRegistration,
    removeRegistration,
    resetAttempt,
    previewImport,
    confirmImport,
  };
}

export type CandidatesService = ReturnType<typeof createCandidatesService>;
