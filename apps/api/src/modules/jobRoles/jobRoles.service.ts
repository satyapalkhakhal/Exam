// modules/jobRoles/jobRoles.service.ts
// Job roles (user-facing: job profiles). Each write is audited in the same
// transaction as the change. Exam settings live on rounds (exams module).

import type { JobRoleCreateInput, JobRoleDto, JobRoleUpdateInput } from '@exam/shared';
import { notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';

export interface JobRoleRow {
  id: string;
  name: string;
  refApplicantCount: number;
  active: boolean;
  _count: { exams: number };
}

export interface JobRolesRepository {
  list(): Promise<JobRoleRow[]>;
  findById(id: string): Promise<JobRoleRow | null>;
  /** Creates the role and its default settings row; throws CONFLICT when the name is taken. */
  create(data: { name: string; refApplicantCount: number }, audit: (id: string) => AuditRecord): Promise<JobRoleRow>;
  /** Throws CONFLICT when the new name is taken. */
  update(id: string, data: JobRoleUpdateInput, audit: AuditRecord): Promise<JobRoleRow>;
}

const toDto = (r: JobRoleRow): JobRoleDto => ({
  id: r.id,
  name: r.name,
  refApplicantCount: r.refApplicantCount,
  active: r.active,
  counts: { exams: r._count.exams },
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

  return { list, create, update };
}

export type JobRolesService = ReturnType<typeof createJobRolesService>;
