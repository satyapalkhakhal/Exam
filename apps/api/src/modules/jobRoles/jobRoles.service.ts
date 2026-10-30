// modules/jobRoles/jobRoles.service.ts
// Job roles and their per-role exam settings. Every role always has a settings
// row (created with the role, defaults 60 min / closed). Each write is audited
// in the same transaction as the change; instructions text is never copied
// into the audit metadata.

import type { ExamSettingDto, ExamSettingsUpdateInput, JobRoleCreateInput, JobRoleDto, JobRoleUpdateInput } from '@exam/shared';
import { notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';

export interface ExamSettingRow {
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
  questionsLocked: boolean;
}

export interface JobRoleRow {
  id: string;
  name: string;
  refApplicantCount: number;
  active: boolean;
  examSetting: ExamSettingRow | null;
  _count: { questions: number; candidates: number };
}

export interface JobRolesRepository {
  list(): Promise<JobRoleRow[]>;
  findById(id: string): Promise<JobRoleRow | null>;
  /** Creates the role and its default settings row; throws CONFLICT when the name is taken. */
  create(data: { name: string; refApplicantCount: number }, audit: (id: string) => AuditRecord): Promise<JobRoleRow>;
  /** Throws CONFLICT when the new name is taken. */
  update(id: string, data: JobRoleUpdateInput, audit: AuditRecord): Promise<JobRoleRow>;
  upsertSettings(jobRoleId: string, data: ExamSettingsWrite, audit: AuditRecord): Promise<ExamSettingRow>;
  getSettings(jobRoleId: string): Promise<ExamSettingRow | null>;
}

export interface ExamSettingsWrite {
  durationMinutes: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  instructions: string;
  isOpen: boolean;
}

export const DEFAULT_SETTINGS: ExamSettingDto = {
  durationMinutes: 60,
  windowStart: null,
  windowEnd: null,
  instructions: '',
  isOpen: false,
  questionsLocked: false,
};

const toSettingDto = (s: ExamSettingRow | null): ExamSettingDto =>
  s
    ? {
        durationMinutes: s.durationMinutes,
        windowStart: s.windowStart?.toISOString() ?? null,
        windowEnd: s.windowEnd?.toISOString() ?? null,
        instructions: s.instructions,
        isOpen: s.isOpen,
        questionsLocked: s.questionsLocked,
      }
    : DEFAULT_SETTINGS;

const toDto = (r: JobRoleRow): JobRoleDto => ({
  id: r.id,
  name: r.name,
  refApplicantCount: r.refApplicantCount,
  active: r.active,
  settings: toSettingDto(r.examSetting),
  counts: { questions: r._count.questions, candidates: r._count.candidates },
});

const ENTITY = 'job_role';

export function createJobRolesService(repo: JobRolesRepository) {
  async function list(): Promise<JobRoleDto[]> {
    return (await repo.list()).map(toDto);
  }

  async function create(input: JobRoleCreateInput, actorId: string, ip: string | null): Promise<JobRoleDto> {
    const row = await repo.create({ name: input.name, refApplicantCount: input.refApplicantCount ?? 0 }, (id) => ({
      adminId: actorId,
      action: 'JOB_ROLE_CREATED',
      entity: ENTITY,
      entityId: id,
      metadata: { name: input.name },
      ip,
    }));
    return toDto(row);
  }

  async function update(id: string, input: JobRoleUpdateInput, actorId: string, ip: string | null): Promise<JobRoleDto> {
    if (!(await repo.findById(id))) throw notFound('Job role not found');
    const row = await repo.update(id, input, {
      adminId: actorId,
      action: 'JOB_ROLE_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: {
        fields: Object.keys(input).filter((k) => input[k as keyof JobRoleUpdateInput] !== undefined),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      ip,
    });
    return toDto(row);
  }

  async function updateSettings(
    id: string,
    input: ExamSettingsUpdateInput,
    actorId: string,
    ip: string | null,
  ): Promise<ExamSettingDto> {
    if (!(await repo.findById(id))) throw notFound('Job role not found');
    const data: ExamSettingsWrite = {
      durationMinutes: input.durationMinutes,
      windowStart: input.windowStart ? new Date(input.windowStart) : null,
      windowEnd: input.windowEnd ? new Date(input.windowEnd) : null,
      instructions: input.instructions,
      isOpen: input.isOpen,
    };
    const row = await repo.upsertSettings(id, data, {
      adminId: actorId,
      action: 'EXAM_SETTINGS_UPDATED',
      entity: ENTITY,
      entityId: id,
      metadata: {
        durationMinutes: data.durationMinutes,
        windowStart: data.windowStart?.toISOString() ?? null,
        windowEnd: data.windowEnd?.toISOString() ?? null,
        isOpen: data.isOpen,
        instructionsLength: data.instructions.length,
      },
      ip,
    });
    return toSettingDto(row);
  }

  /** Internal read for the exam engine; null when the role has no settings row. */
  const getSettings = (jobRoleId: string): Promise<ExamSettingRow | null> => repo.getSettings(jobRoleId);

  return { list, create, update, updateSettings, getSettings };
}

export type JobRolesService = ReturnType<typeof createJobRolesService>;
