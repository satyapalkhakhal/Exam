// modules/questions/questions.service.ts
// Questions per job role (design §5). Every write first checks the role's
// questionsLocked flag (423 QUESTIONS_LOCKED); the exam start sets it, and only
// a Super Admin can lift it (audited). Duplicates are by normalised text within
// the role. Import is two steps: preview parses and caches the result in Redis
// (30 min, bound to the admin who uploaded it), confirm inserts the cached
// valid rows in one transaction and records an ImportBatch. Question text is
// never copied into audit metadata.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  ImportConfirmInput,
  ImportPreviewDto,
  ImportResultDto,
  Paginated,
  QuestionCreateInput,
  QuestionDto,
  QuestionImportRow,
  QuestionListQuery,
  QuestionUpdateInput,
} from '@exam/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { sha256 } from '../../shared/utils/hash.js';
import { questionHash } from '../../shared/utils/questionHash.js';
import { readSheet } from '../../shared/utils/spreadsheet.js';
import type { AuditRecord } from '../audit/index.js';
import { parseQuestionRows, TEMPLATE_COLUMNS, type ParsedQuestions } from './questionImport.parser.js';

export interface QuestionRow {
  id: string;
  jobRoleId: string;
  text: string;
  maxMarks: { toNumber(): number } | number;
  evaluatorGuidance: string | null;
  displayOrder: number;
  active: boolean;
}

export interface NewQuestion {
  jobRoleId: string;
  text: string;
  normalizedTextHash: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
}

export interface QuestionsRepository {
  /** null when the role does not exist; otherwise whether its questions are locked. */
  roleLockState(jobRoleId: string): Promise<{ locked: boolean } | null>;
  findById(id: string): Promise<QuestionRow | null>;
  list(jobRoleId: string, skip: number, take: number): Promise<{ rows: QuestionRow[]; total: number }>;
  existingHashes(jobRoleId: string): Promise<Set<string>>;
  maxDisplayOrder(jobRoleId: string): Promise<number>;
  /** Throws CONFLICT when the normalised text already exists in the role. */
  create(data: NewQuestion, audit: (id: string) => AuditRecord): Promise<QuestionRow>;
  /** Throws CONFLICT when the new text collides with another question of the role. */
  update(id: string, jobRoleId: string, data: Partial<Omit<NewQuestion, 'jobRoleId'>>, audit: AuditRecord): Promise<QuestionRow>;
  setActive(id: string, jobRoleId: string, active: boolean, audit: AuditRecord): Promise<QuestionRow>;
  /** Returns false when any id is not a question of the role; nothing is written then. */
  reorder(jobRoleId: string, ids: string[], audit: AuditRecord): Promise<boolean>;
  unlock(jobRoleId: string, audit: AuditRecord): Promise<void>;
  lastImportOf(jobRoleId: string, fileHash: string): Promise<Date | null>;
  /** One transaction: rows (duplicates skipped), the ImportBatch and the audit row. */
  confirmImport(input: ImportCommit): Promise<number>;
}

export interface ImportCommit {
  jobRoleId: string;
  fileName: string;
  fileHash: string;
  uploadedById: string;
  total: number;
  rows: NewQuestion[];
  errors: unknown[];
  audit: (imported: number) => AuditRecord;
}

interface CachedPreview extends ParsedQuestions {
  adminId: string;
  jobRoleId: string;
  fileName: string;
  fileHash: string;
  total: number;
  /** valid drafts with display order resolved at preview time */
  rows: QuestionImportRow[];
}

export const PREVIEW_TTL_SECONDS = 30 * 60;
export const previewKey = (id: string): string => `exam:import:${id}`;
const ENTITY = 'question';

const locked = () => new AppError(423, 'QUESTIONS_LOCKED', 'Questions are locked for this role. A Super Admin can unlock them.');

const toDto = (r: QuestionRow): QuestionDto => ({
  id: r.id,
  jobRoleId: r.jobRoleId,
  questionText: r.text,
  maxMarks: typeof r.maxMarks === 'number' ? r.maxMarks : r.maxMarks.toNumber(),
  evaluatorGuidance: r.evaluatorGuidance,
  displayOrder: r.displayOrder,
  active: r.active,
});

export interface QuestionsDeps {
  redis: () => Redis;
}

export function createQuestionsService(repo: QuestionsRepository, deps: QuestionsDeps) {
  async function assertWritable(jobRoleId: string): Promise<void> {
    const state = await repo.roleLockState(jobRoleId);
    if (!state) throw notFound('Job role not found');
    if (state.locked) throw locked();
  }

  async function list(query: QuestionListQuery): Promise<Paginated<QuestionDto>> {
    if (!(await repo.roleLockState(query.jobRoleId))) throw notFound('Job role not found');
    const { rows, total } = await repo.list(query.jobRoleId, (query.page - 1) * query.pageSize, query.pageSize);
    return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
  }

  async function create(input: QuestionCreateInput, actorId: string, ip: string | null): Promise<QuestionDto> {
    await assertWritable(input.jobRoleId);
    const displayOrder = (await repo.maxDisplayOrder(input.jobRoleId)) + 1;
    const row = await repo.create(
      {
        jobRoleId: input.jobRoleId,
        text: input.questionText,
        normalizedTextHash: questionHash(input.questionText),
        maxMarks: input.maxMarks,
        evaluatorGuidance: input.evaluatorGuidance,
        displayOrder,
      },
      (id) => ({
        adminId: actorId,
        action: 'QUESTION_CREATED',
        entity: ENTITY,
        entityId: id,
        metadata: { jobRoleId: input.jobRoleId, maxMarks: input.maxMarks },
        ip,
      }),
    );
    return toDto(row);
  }

  async function update(id: string, input: QuestionUpdateInput, actorId: string, ip: string | null): Promise<QuestionDto> {
    const existing = await repo.findById(id);
    if (!existing) throw notFound('Question not found');
    await assertWritable(existing.jobRoleId);
    const data: Partial<Omit<NewQuestion, 'jobRoleId'>> = {};
    if (input.questionText !== undefined) {
      data.text = input.questionText;
      data.normalizedTextHash = questionHash(input.questionText);
    }
    if (input.maxMarks !== undefined) data.maxMarks = input.maxMarks;
    if (input.evaluatorGuidance !== undefined) data.evaluatorGuidance = input.evaluatorGuidance === '' ? null : input.evaluatorGuidance;
    if (input.displayOrder !== undefined) data.displayOrder = input.displayOrder;
    const row = await repo.update(id, existing.jobRoleId, data, {
      adminId: actorId,
      action: 'QUESTION_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: { jobRoleId: existing.jobRoleId, fields: Object.keys(input).filter((k) => input[k as keyof QuestionUpdateInput] !== undefined) },
      ip,
    });
    return toDto(row);
  }

  async function setActive(id: string, active: boolean, actorId: string, ip: string | null): Promise<QuestionDto> {
    const existing = await repo.findById(id);
    if (!existing) throw notFound('Question not found');
    await assertWritable(existing.jobRoleId);
    const row = await repo.setActive(id, existing.jobRoleId, active, {
      adminId: actorId,
      action: active ? 'QUESTION_ACTIVATED' : 'QUESTION_DEACTIVATED',
      entity: ENTITY,
      entityId: id,
      metadata: { jobRoleId: existing.jobRoleId },
      ip,
    });
    return toDto(row);
  }

  async function reorder(jobRoleId: string, ids: string[], actorId: string, ip: string | null): Promise<{ updated: number }> {
    await assertWritable(jobRoleId);
    if (new Set(ids).size !== ids.length) throw badRequest('Duplicate question ids');
    const done = await repo.reorder(jobRoleId, ids, {
      adminId: actorId,
      action: 'QUESTIONS_REORDERED',
      entity: 'job_role',
      entityId: jobRoleId,
      metadata: { count: ids.length },
      ip,
    });
    if (!done) throw badRequest('Every id must be a question of this role');
    return { updated: ids.length };
  }

  async function unlock(jobRoleId: string, reason: string, actorId: string, ip: string | null): Promise<{ questionsLocked: false }> {
    if (!(await repo.roleLockState(jobRoleId))) throw notFound('Job role not found');
    await repo.unlock(jobRoleId, {
      adminId: actorId,
      action: 'QUESTIONS_UNLOCKED',
      entity: 'job_role',
      entityId: jobRoleId,
      metadata: { reason },
      ip,
    });
    return { questionsLocked: false };
  }

  async function previewImport(
    file: { buffer: Buffer; originalname: string },
    jobRoleId: string,
    actorId: string,
  ): Promise<ImportPreviewDto<QuestionImportRow>> {
    await assertWritable(jobRoleId);
    const sheet = await readSheet(file.buffer, file.originalname);
    const missing = (['question_text', 'max_marks'] as const).filter((c) => !sheet.headers.includes(c));
    if (missing.length > 0) {
      throw badRequest(`Missing required column: ${missing.join(', ')}. Expected: ${TEMPLATE_COLUMNS.join(', ')}`);
    }
    const parsed = parseQuestionRows(sheet.rows, await repo.existingHashes(jobRoleId), sheet.rowNumbers);
    let next = (await repo.maxDisplayOrder(jobRoleId)) + 1;
    const rows: QuestionImportRow[] = parsed.valid.map((d) => ({
      row: d.row,
      questionText: d.questionText,
      maxMarks: d.maxMarks,
      evaluatorGuidance: d.evaluatorGuidance,
      displayOrder: d.displayOrder ?? next++,
    }));
    const previewId = randomUUID();
    const fileHash = sha256(file.buffer.toString('base64'));
    const cached: CachedPreview = {
      ...parsed,
      adminId: actorId,
      jobRoleId,
      fileName: file.originalname,
      fileHash,
      total: sheet.rows.length,
      rows,
    };
    await deps.redis().set(previewKey(previewId), JSON.stringify(cached), 'EX', PREVIEW_TTL_SECONDS);
    return {
      previewId,
      fileHash,
      summary: { total: cached.total, valid: rows.length, errors: parsed.errors.length, duplicates: parsed.duplicates.length },
      valid: rows,
      errors: parsed.errors,
      duplicates: parsed.duplicates,
    };
  }

  async function confirmImport(input: ImportConfirmInput, actorId: string, ip: string | null): Promise<ImportResultDto> {
    const raw = await deps.redis().get(previewKey(input.previewId));
    if (!raw) throw notFound('This preview has expired. Upload the file again.');
    const cached = JSON.parse(raw) as CachedPreview;
    if (cached.adminId !== actorId) throw forbidden('This preview belongs to another admin');
    await assertWritable(cached.jobRoleId);

    if (!input.force) {
      const previous = await repo.lastImportOf(cached.jobRoleId, cached.fileHash);
      if (previous) throw conflict(`This file was already imported on ${previous.toISOString().slice(0, 10)}`);
    }

    const imported = await repo.confirmImport({
      jobRoleId: cached.jobRoleId,
      fileName: cached.fileName,
      fileHash: cached.fileHash,
      uploadedById: actorId,
      total: cached.total,
      rows: cached.rows.map((r) => ({
        jobRoleId: cached.jobRoleId,
        text: r.questionText,
        normalizedTextHash: questionHash(r.questionText),
        maxMarks: r.maxMarks,
        evaluatorGuidance: r.evaluatorGuidance,
        displayOrder: r.displayOrder,
      })),
      errors: [...cached.errors, ...cached.duplicates],
      audit: (n) => ({
        adminId: actorId,
        action: 'QUESTIONS_IMPORTED',
        entity: 'job_role',
        entityId: cached.jobRoleId,
        metadata: { fileName: cached.fileName, total: cached.total, imported: n, forced: input.force === true },
        ip,
      }),
    });
    await deps.redis().del(previewKey(input.previewId));
    return { imported, skipped: cached.total - imported };
  }

  return { list, create, update, setActive, reorder, unlock, previewImport, confirmImport };
}

export type QuestionsService = ReturnType<typeof createQuestionsService>;
