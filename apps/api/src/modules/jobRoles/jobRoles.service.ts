// modules/jobRoles/jobRoles.service.ts
// Job roles (UI: job profiles) with their type (Placement/Internship) and
// rounds. Round 1 is created with the role. Rounds and drives are edited in the
// drives module; here they are only listed: a Super Admin sees each round's
// drives, an Evaluator gets rounds without drives (blind marking). Each write
// is audited in the same transaction as the change.

import type { JobProfileType, JobRoleCreateInput, JobRoleDto, JobRoleUpdateInput } from '@exam/shared';
import { notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';
import { toRoundDto, type DriveRow, type RoundRow } from '../drives/index.js';

export interface JobRoleRow {
  id: string;
  name: string;
  type: JobProfileType;
  refApplicantCount: number;
  active: boolean;
  rounds: RoundRow[];
  candidateCount: number;
}

export interface JobRolesRepository {
  list(): Promise<JobRoleRow[]>;
  findById(id: string): Promise<JobRoleRow | null>;
  /** Creates the role and its Round 1; throws CONFLICT when (name, type) is taken (case-insensitive). */
  create(data: { name: string; type: JobProfileType; refApplicantCount: number }, audit: (id: string) => AuditRecord): Promise<JobRoleRow>;
  /** Throws CONFLICT when the new (name, type) is taken. */
  update(id: string, data: JobRoleUpdateInput, audit: AuditRecord): Promise<JobRoleRow>;
}

export interface JobRolesDeps {
  /** Every drive, for the Super Admin view. */
  listDrives(): Promise<DriveRow[]>;
}

export type ViewerRole = 'SUPER_ADMIN' | 'EVALUATOR';

const toDto = (r: JobRoleRow, drivesByRound: Map<string, DriveRow[]> | null): JobRoleDto => ({
  id: r.id,
  name: r.name,
  type: r.type,
  refApplicantCount: r.refApplicantCount,
  active: r.active,
  rounds: r.rounds.map((round) => toRoundDto(round, drivesByRound ? (drivesByRound.get(round.id) ?? []) : undefined)),
  counts: { candidates: r.candidateCount },
});

const ENTITY = 'job_role';

export function createJobRolesService(repo: JobRolesRepository, deps: JobRolesDeps) {
  async function drivesFor(viewer: ViewerRole): Promise<Map<string, DriveRow[]> | null> {
    if (viewer !== 'SUPER_ADMIN') return null;
    const map = new Map<string, DriveRow[]>();
    for (const d of await deps.listDrives()) map.set(d.roundId, [...(map.get(d.roundId) ?? []), d]);
    return map;
  }

  async function list(viewer: ViewerRole): Promise<JobRoleDto[]> {
    const [rows, drives] = await Promise.all([repo.list(), drivesFor(viewer)]);
    return rows.map((r) => toDto(r, drives));
  }

  async function create(input: JobRoleCreateInput, actorId: string, ip: string | null): Promise<JobRoleDto> {
    const row = await repo.create({ name: input.name, type: input.type, refApplicantCount: input.refApplicantCount ?? 0 }, (id) => ({
      adminId: actorId,
      action: 'JOB_ROLE_CREATED',
      entity: ENTITY,
      entityId: id,
      metadata: { name: input.name, type: input.type },
      ip,
    }));
    return toDto(row, new Map());
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
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      ip,
    });
    return toDto(row, await drivesFor('SUPER_ADMIN'));
  }

  return { list, create, update };
}

export type JobRolesService = ReturnType<typeof createJobRolesService>;
