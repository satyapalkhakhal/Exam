// modules/exams/exams.service.ts
// Exams (job profile -> exams -> rounds) and per-round settings. Every write is
// audited in the same transaction as the change; instructions text is never
// copied into audit metadata.

import type { ExamCreateInput, ExamDto, ExamUpdateInput, RoundCreateInput, RoundDto, RoundSettingsInput } from '@exam/shared';
import { notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';

export interface RoundRow {
  id: string;
  examId: string;
  roundNumber: number;
  name: string | null;
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
  questionsLocked: boolean;
  _count: { questions: number; entries: number };
}

export interface ExamRow {
  id: string;
  jobRoleId: string;
  name: string;
  active: boolean;
  jobRole: { name: string };
  rounds: RoundRow[];
}

export interface RoundSettingsWrite {
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
}

export interface ExamsRepository {
  list(filter: { jobRoleId?: string; active?: boolean }): Promise<ExamRow[]>;
  findById(id: string): Promise<ExamRow | null>;
  jobRoleExists(id: string): Promise<boolean>;
  /** Throws CONFLICT when the name is taken. */
  create(data: { jobRoleId: string; name: string }, audit: (id: string) => AuditRecord): Promise<ExamRow>;
  /** Throws CONFLICT when the new name is taken. */
  update(id: string, data: ExamUpdateInput, audit: AuditRecord): Promise<ExamRow>;
  /** Locks the exam, assigns max+1, backfills shortlisted people; throws NOT_FOUND for an unknown exam. */
  addRound(
    examId: string,
    name: string | null,
    adminId: string,
    audit: (round: { id: string; roundNumber: number }, backfilled: number) => AuditRecord,
  ): Promise<RoundRow>;
  /** Locks the round FOR UPDATE; throws NOT_FOUND for an unknown round. */
  updateRoundSettings(roundId: string, data: RoundSettingsWrite, audit: AuditRecord): Promise<RoundRow>;
}

const toRoundDto = (r: RoundRow): RoundDto => ({
  id: r.id,
  examId: r.examId,
  roundNumber: r.roundNumber,
  name: r.name ?? '',
  durationMinutes: r.durationMinutes,
  windowStart: r.windowStart?.toISOString() ?? null,
  windowEnd: r.windowEnd?.toISOString() ?? null,
  instructions: r.instructions,
  isOpen: r.isOpen,
  questionsLocked: r.questionsLocked,
  counts: { questions: r._count.questions, entries: r._count.entries },
});

const toDto = (e: ExamRow): ExamDto => ({
  id: e.id,
  jobRoleId: e.jobRoleId,
  jobRoleName: e.jobRole.name,
  name: e.name,
  active: e.active,
  rounds: [...e.rounds].sort((a, b) => a.roundNumber - b.roundNumber).map(toRoundDto),
});

const EXAM = 'exam';
const ROUND = 'exam_round';

export function createExamsService(repo: ExamsRepository) {
  async function list(filter: { jobRoleId?: string; active?: boolean }): Promise<ExamDto[]> {
    return (await repo.list(filter)).map(toDto);
  }

  async function create(input: ExamCreateInput, actorId: string, ip: string | null): Promise<ExamDto> {
    if (!(await repo.jobRoleExists(input.jobRoleId))) throw notFound('Job profile not found');
    const row = await repo.create({ jobRoleId: input.jobRoleId, name: input.name }, (id) => ({
      adminId: actorId,
      action: 'EXAM_CREATED',
      entity: EXAM,
      entityId: id,
      metadata: { name: input.name, jobRoleId: input.jobRoleId },
      ip,
    }));
    return toDto(row);
  }

  async function update(id: string, input: ExamUpdateInput, actorId: string, ip: string | null): Promise<ExamDto> {
    if (!(await repo.findById(id))) throw notFound('Exam not found');
    const row = await repo.update(id, input, {
      adminId: actorId,
      action: 'EXAM_UPDATED',
      entity: EXAM,
      entityId: id,
      metadata: {
        fields: Object.keys(input).filter((k) => input[k as keyof ExamUpdateInput] !== undefined),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      ip,
    });
    return toDto(row);
  }

  async function addRound(examId: string, input: RoundCreateInput, actorId: string, ip: string | null): Promise<RoundDto> {
    const row = await repo.addRound(examId, input.name?.trim() || null, actorId, (round, backfilled) => ({
      adminId: actorId,
      action: 'ROUND_CREATED',
      entity: ROUND,
      entityId: round.id,
      metadata: { examId, roundNumber: round.roundNumber, backfilled },
      ip,
    }));
    return toRoundDto(row);
  }

  async function updateRoundSettings(
    roundId: string,
    input: RoundSettingsInput,
    actorId: string,
    ip: string | null,
  ): Promise<RoundDto> {
    const data: RoundSettingsWrite = {
      durationMinutes: input.durationMinutes,
      windowStart: input.windowStart ? new Date(input.windowStart) : null,
      windowEnd: input.windowEnd ? new Date(input.windowEnd) : null,
      instructions: input.instructions,
      isOpen: input.isOpen,
    };
    const row = await repo.updateRoundSettings(roundId, data, {
      adminId: actorId,
      action: 'ROUND_SETTINGS_UPDATED',
      entity: ROUND,
      entityId: roundId,
      metadata: {
        durationMinutes: data.durationMinutes,
        windowStart: data.windowStart?.toISOString() ?? null,
        windowEnd: data.windowEnd?.toISOString() ?? null,
        isOpen: data.isOpen,
        instructionsLength: data.instructions.length,
      },
      ip,
    });
    return toRoundDto(row);
  }

  return { list, create, update, addRound, updateRoundSettings };
}

export type ExamsService = ReturnType<typeof createExamsService>;
