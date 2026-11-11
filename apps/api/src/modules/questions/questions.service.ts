// modules/questions/questions.service.ts
// Questions per round (design §5; rounds: spec 2026-11-10). Every write first checks the round's
// questionsLocked flag (423 QUESTIONS_LOCKED); the exam start sets it, and only
// a Super Admin can lift it (audited). Duplicates are by normalised text within
// the round. Import is two steps: preview parses and caches the result in Redis
// (30 min, bound to the admin who uploaded it), confirm inserts the cached
// valid rows in one transaction and records an ImportBatch. Question text is
// never copied into audit metadata.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  CopyQuestionsInput,
  CopyQuestionsResultDto,
  ImportConfirmInput,
  ImportPreviewDto,
  ImportResultDto,
  Paginated,
  QuestionCreateInput,
  QuestionDto,
  QuestionImportRow,
  QuestionListQuery,
  QuestionType,
  QuestionUpdateInput,
} from '@exam/shared';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { sha256 } from '../../shared/utils/hash.js';
import { hashFor } from '../../shared/utils/questionHash.js';
import { readSheet } from '../../shared/utils/spreadsheet.js';
import type { AuditRecord } from '../audit/index.js';
import { parseQuestionRows, TEMPLATE_COLUMNS, type ParsedQuestions } from './questionImport.parser.js';

export interface QuestionRow {
  id: string;
  roundId: string;
  type: QuestionType;
  text: string;
  options: string[];
  correctOption: number | null;
  maxMarks: { toNumber(): number } | number;
  evaluatorGuidance: string | null;
  displayOrder: number;
  active: boolean;
}

export interface NewQuestion {
  roundId: string;
  type: QuestionType;
  text: string;
  /** MCQ: 4 options (A–D order); [] for written. */
  options: string[];
  correctOption: number | null;
  normalizedTextHash: string;
  maxMarks: number;
  evaluatorGuidance: string | null;
  displayOrder: number;
}

export interface QuestionsRepository {
  /** null when the round does not exist; otherwise whether its questions are locked. */
  roundLockState(roundId: string): Promise<{ locked: boolean } | null>;
  findById(id: string): Promise<QuestionRow | null>;
  list(roundId: string, skip: number, take: number): Promise<{ rows: QuestionRow[]; total: number }>;
  existingHashes(roundId: string): Promise<Set<string>>;
  maxDisplayOrder(roundId: string): Promise<number>;
  /** Throws CONFLICT when the normalised text already exists in the role. */
  create(data: NewQuestion, audit: (id: string) => AuditRecord): Promise<QuestionRow>;
  /** Throws CONFLICT when the new text collides with another question of the role. */
  update(id: string, roundId: string, data: Partial<Omit<NewQuestion, 'roundId'>>, audit: AuditRecord): Promise<QuestionRow>;
  setActive(id: string, roundId: string, active: boolean, audit: AuditRecord): Promise<QuestionRow>;
  /** Returns false when any id is not a question of the role; nothing is written then. */
  reorder(roundId: string, ids: string[], audit: AuditRecord): Promise<boolean>;
  unlock(roundId: string, audit: AuditRecord): Promise<void>;
  lastImportOf(roundId: string, fileHash: string): Promise<Date | null>;
  /** One transaction: rows (duplicates skipped), the ImportBatch and the audit row. */
  confirmImport(input: ImportCommit): Promise<number>;
  /**
   * One transaction under the target round's lock (423 when locked): with
   * `replace` the target's active questions are deactivated first, otherwise a
   * target that has any question is refused 409 TARGET_HAS_QUESTIONS.
   */
  copyQuestions(input: CopyCommit): Promise<CopyQuestionsResultDto>;
}

export interface CopyCommit {
  fromRoundId: string;
  targetRoundId: string;
  replace: boolean;
  audit: (copied: number) => AuditRecord;
}

export interface ImportCommit {
  roundId: string;
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
  roundId: string;
  fileName: string;
  fileHash: string;
  total: number;
  /** valid drafts with display order resolved at preview time */
  rows: QuestionImportRow[];
}

export const PREVIEW_TTL_SECONDS = 30 * 60;
export const previewKey = (id: string): string => `exam:import:${id}`;
const ENTITY = 'question';

const locked = () => new AppError(423, 'QUESTIONS_LOCKED', 'Questions are locked for this round. A Super Admin can unlock them.');

const toDto = (r: QuestionRow): QuestionDto => ({
  id: r.id,
  roundId: r.roundId,
  type: r.type,
  questionText: r.text,
  options: r.options,
  correctOption: r.correctOption,
  maxMarks: typeof r.maxMarks === 'number' ? r.maxMarks : r.maxMarks.toNumber(),
  evaluatorGuidance: r.evaluatorGuidance,
  displayOrder: r.displayOrder,
  active: r.active,
});

export interface QuestionsDeps {
  redis: () => Redis;
}

export function createQuestionsService(repo: QuestionsRepository, deps: QuestionsDeps) {
  async function assertWritable(roundId: string): Promise<void> {
    const state = await repo.roundLockState(roundId);
    if (!state) throw notFound('Round not found');
    if (state.locked) throw locked();
  }

  async function list(query: QuestionListQuery): Promise<Paginated<QuestionDto>> {
    if (!(await repo.roundLockState(query.roundId))) throw notFound('Round not found');
    const { rows, total } = await repo.list(query.roundId, (query.page - 1) * query.pageSize, query.pageSize);
    return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
  }

  async function create(input: QuestionCreateInput, actorId: string, ip: string | null): Promise<QuestionDto> {
    await assertWritable(input.roundId);
    const displayOrder = (await repo.maxDisplayOrder(input.roundId)) + 1;
    const row = await repo.create(
      {
        roundId: input.roundId,
        type: input.type,
        text: input.questionText,
        options: input.type === 'MCQ' ? input.options! : [],
        correctOption: input.type === 'MCQ' ? input.correctOption! : null,
        normalizedTextHash: hashFor({ type: input.type, text: input.questionText, options: input.options ?? [] }),
        maxMarks: input.maxMarks,
        evaluatorGuidance: input.evaluatorGuidance,
        displayOrder,
      },
      (id) => ({
        adminId: actorId,
        action: 'QUESTION_CREATED',
        entity: ENTITY,
        entityId: id,
        metadata: { roundId: input.roundId, type: input.type, maxMarks: input.maxMarks },
        ip,
      }),
    );
    return toDto(row);
  }

  async function update(id: string, input: QuestionUpdateInput, actorId: string, ip: string | null): Promise<QuestionDto> {
    const existing = await repo.findById(id);
    if (!existing) throw notFound('Question not found');
    await assertWritable(existing.roundId);
    if (existing.type !== 'MCQ' && (input.options !== undefined || input.correctOption !== undefined)) {
      throw badRequest('A written question has no options');
    }
    const data: Partial<Omit<NewQuestion, 'roundId' | 'type'>> = {};
    if (input.questionText !== undefined) data.text = input.questionText;
    if (input.options !== undefined) data.options = input.options;
    if (input.correctOption !== undefined) data.correctOption = input.correctOption;
    if (input.questionText !== undefined || input.options !== undefined) {
      data.normalizedTextHash = hashFor({ type: existing.type, text: input.questionText ?? existing.text, options: input.options ?? existing.options });
    }
    if (input.maxMarks !== undefined) data.maxMarks = input.maxMarks;
    if (input.evaluatorGuidance !== undefined) data.evaluatorGuidance = input.evaluatorGuidance === '' ? null : input.evaluatorGuidance;
    if (input.displayOrder !== undefined) data.displayOrder = input.displayOrder;
    const row = await repo.update(id, existing.roundId, data, {
      adminId: actorId,
      action: 'QUESTION_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: { roundId: existing.roundId, fields: Object.keys(input).filter((k) => input[k as keyof QuestionUpdateInput] !== undefined) },
      ip,
    });
    return toDto(row);
  }

  async function setActive(id: string, active: boolean, actorId: string, ip: string | null): Promise<QuestionDto> {
    const existing = await repo.findById(id);
    if (!existing) throw notFound('Question not found');
    await assertWritable(existing.roundId);
    const row = await repo.setActive(id, existing.roundId, active, {
      adminId: actorId,
      action: active ? 'QUESTION_ACTIVATED' : 'QUESTION_DEACTIVATED',
      entity: ENTITY,
      entityId: id,
      metadata: { roundId: existing.roundId },
      ip,
    });
    return toDto(row);
  }

  async function reorder(roundId: string, ids: string[], actorId: string, ip: string | null): Promise<{ updated: number }> {
    await assertWritable(roundId);
    if (new Set(ids).size !== ids.length) throw badRequest('Duplicate question ids');
    const done = await repo.reorder(roundId, ids, {
      adminId: actorId,
      action: 'QUESTIONS_REORDERED',
      entity: 'exam_round',
      entityId: roundId,
      metadata: { count: ids.length },
      ip,
    });
    if (!done) throw badRequest('Every id must be a question of this round');
    return { updated: ids.length };
  }

  async function unlock(roundId: string, reason: string, actorId: string, ip: string | null): Promise<{ questionsLocked: false }> {
    if (!(await repo.roundLockState(roundId))) throw notFound('Round not found');
    await repo.unlock(roundId, {
      adminId: actorId,
      action: 'QUESTIONS_UNLOCKED',
      entity: 'exam_round',
      entityId: roundId,
      metadata: { reason },
      ip,
    });
    return { questionsLocked: false };
  }

  async function previewImport(
    file: { buffer: Buffer; originalname: string },
    roundId: string,
    actorId: string,
  ): Promise<ImportPreviewDto<QuestionImportRow>> {
    await assertWritable(roundId);
    const sheet = await readSheet(file.buffer, file.originalname);
    const missing = (['question_text', 'max_marks'] as const).filter((c) => !sheet.headers.includes(c));
    if (missing.length > 0) {
      throw badRequest(`Missing required column: ${missing.join(', ')}. Expected: ${TEMPLATE_COLUMNS.join(', ')}`);
    }
    const parsed = parseQuestionRows(sheet.rows, await repo.existingHashes(roundId), sheet.rowNumbers);
    let next = (await repo.maxDisplayOrder(roundId)) + 1;
    const rows: QuestionImportRow[] = parsed.valid.map((d) => ({
      row: d.row,
      type: d.type,
      questionText: d.questionText,
      options: d.options,
      correctOption: d.correctOption,
      maxMarks: d.maxMarks,
      evaluatorGuidance: d.evaluatorGuidance,
      displayOrder: d.displayOrder ?? next++,
    }));
    const previewId = randomUUID();
    const fileHash = sha256(file.buffer.toString('base64'));
    const cached: CachedPreview = {
      ...parsed,
      adminId: actorId,
      roundId,
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
    await assertWritable(cached.roundId);

    if (!input.force) {
      const previous = await repo.lastImportOf(cached.roundId, cached.fileHash);
      if (previous) throw conflict(`This file was already imported on ${previous.toISOString().slice(0, 10)}`);
    }

    const imported = await repo.confirmImport({
      roundId: cached.roundId,
      fileName: cached.fileName,
      fileHash: cached.fileHash,
      uploadedById: actorId,
      total: cached.total,
      rows: cached.rows.map((r) => ({
        roundId: cached.roundId,
        type: r.type,
        text: r.questionText,
        options: r.options,
        correctOption: r.correctOption,
        normalizedTextHash: hashFor({ type: r.type, text: r.questionText, options: r.options }),
        maxMarks: r.maxMarks,
        evaluatorGuidance: r.evaluatorGuidance,
        displayOrder: r.displayOrder,
      })),
      errors: [...cached.errors, ...cached.duplicates],
      audit: (n) => ({
        adminId: actorId,
        action: 'QUESTIONS_IMPORTED',
        entity: 'exam_round',
        entityId: cached.roundId,
        metadata: { fileName: cached.fileName, total: cached.total, imported: n, forced: input.force === true },
        ip,
      }),
    });
    await deps.redis().del(previewKey(input.previewId));
    return { imported, skipped: cached.total - imported };
  }

  async function copyFrom(targetRoundId: string, input: CopyQuestionsInput, actorId: string, ip: string | null): Promise<CopyQuestionsResultDto> {
    if (input.fromRoundId === targetRoundId) throw badRequest('Choose a different round to copy from');
    const [target, source] = await Promise.all([repo.roundLockState(targetRoundId), repo.roundLockState(input.fromRoundId)]);
    if (!target || !source) throw notFound('Round not found');
    if (target.locked) throw locked();
    return repo.copyQuestions({
      fromRoundId: input.fromRoundId,
      targetRoundId,
      replace: input.replace,
      audit: (copied) => ({
        adminId: actorId,
        action: 'QUESTIONS_COPIED',
        entity: 'exam_round',
        entityId: targetRoundId,
        metadata: { fromRoundId: input.fromRoundId, replace: input.replace, copied },
        ip,
      }),
    });
  }

  return { list, create, update, setActive, reorder, unlock, previewImport, confirmImport, copyFrom };
}

export type QuestionsService = ReturnType<typeof createQuestionsService>;
