// modules/drives/drives.service.ts
// Colleges, rounds and campus drives (docs/superpowers/specs/2026-11-10-colleges-
// drives-rounds-design.md). A job profile has ordered rounds (questions,
// duration, weights, question lock — shared by every college); a drive is one
// round at one college in one batch (window, open switch, instructions).
// Super Admin only. Every write is audited in the same transaction; the
// instructions text is never copied into audit metadata.

import {
  driveDisplayName,
  type CollegeCreateInput,
  type CollegeDto,
  type CollegeUpdateInput,
  type CompositeWeights,
  type DriveCreateInput,
  type DriveDto,
  type DriveListQuery,
  type DriveUpdateInput,
  type JobProfileType,
  type PromoteResultDto,
  type RoundCreateInput,
  type RoundDto,
  type RoundSettingsInput,
} from '@exam/shared';
import { AppError, badRequest, conflict, notFound } from '../../shared/errors.js';
import type { AuditRecord } from '../audit/index.js';

export interface Actor {
  id: string;
  ip: string | null;
}

export interface CollegeRow {
  id: string;
  name: string;
  shortCode: string;
  active: boolean;
  driveCount: number;
}

export interface RoundRow {
  id: string;
  jobRoleId: string;
  roundNumber: number;
  name: string | null;
  durationMinutes: number;
  questionsLocked: boolean;
  weightExam: number;
  weightX: number;
  weightXii: number;
  weightCpi: number;
  mcqNegativeMarks: number;
  questionCount: number;
}

export interface DriveRow {
  id: string;
  roundId: string;
  roundNumber: number;
  jobRoleId: string;
  jobRoleName: string;
  jobProfileType: JobProfileType;
  college: { id: string; name: string; shortCode: string };
  batch: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  isOpen: boolean;
  instructions: string;
  active: boolean;
  candidateCount: number;
  startedCount: number;
}

export interface RoundWrite {
  name?: string | null;
  durationMinutes: number;
  /** Omitted keeps the stored value. */
  mcqNegativeMarks?: number;
  /** Omitted keeps the stored weights. */
  weights?: CompositeWeights;
}

/** The round as read under its row lock, for a settings change to be checked against. */
export interface RoundGuardState {
  questionsLocked: boolean;
  mcqNegativeMarks: number;
  /** Smallest active MCQ marks in the round; null when it has none. */
  minMcqMarks: number | null;
}

export interface DriveWrite {
  batch?: string;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  instructions?: string;
  isOpen?: boolean;
  active?: boolean;
}

export interface DrivesRepository {
  listColleges(): Promise<CollegeRow[]>;
  findCollege(id: string): Promise<CollegeRow | null>;
  /** Throws CONFLICT when the name (case-insensitive) or short code is taken. */
  createCollege(data: { name: string; shortCode: string }, audit: (id: string) => AuditRecord): Promise<CollegeRow>;
  updateCollege(id: string, data: CollegeUpdateInput, audit: AuditRecord): Promise<CollegeRow>;
  roleExists(jobRoleId: string): Promise<boolean>;
  /** Next round number (max + 1) under a lock on the job role row. */
  addRound(jobRoleId: string, name: string | null, audit: (id: string, roundNumber: number) => AuditRecord): Promise<RoundRow>;
  findRound(id: string): Promise<RoundRow | null>;
  /** The smallest marks of an active MCQ in the round, or null when it has none. */
  /**
   * `guard` runs inside the transaction with the round row held FOR UPDATE (the row every
   * start holds while it freezes the negative marking) and may throw to refuse the change.
   */
  updateRound(id: string, data: RoundWrite, audit: AuditRecord, guard?: (current: RoundGuardState) => void): Promise<RoundRow>;
  listDrives(q: DriveListQuery): Promise<DriveRow[]>;
  findDrive(id: string): Promise<DriveRow | null>;
  /** Throws CONFLICT when (round, college, lower(batch)) is taken. */
  createDrive(
    data: { roundId: string; collegeId: string; batch: string; windowStart: Date | null; windowEnd: Date | null; instructions: string; isOpen: boolean },
    audit: (id: string) => AuditRecord,
  ): Promise<DriveRow>;
  updateDrive(id: string, data: DriveWrite, audit: AuditRecord): Promise<DriveRow>;
  /** The drive of a round at a college with this batch (case-insensitive), or null. */
  findDriveFor(roundId: string, collegeId: string, batch: string): Promise<DriveRow | null>;
  /** Round n+1 of the same job profile, or null. */
  nextRound(roundId: string): Promise<{ id: string } | null>;
  /**
   * One transaction: every SHORTLISTED entry of the source drive whose person
   * has no entry in the target yet gets one (copied profile, new code, NOT_STARTED,
   * promotedFromId), under the account row locks; a person with an entry in
   * another college's drive of the target round + batch is skipped
   * SAME_ROUND_BATCH. Audits each new entry and the run.
   */
  promote(
    sourceDriveId: string,
    target: DriveRow,
    audit: { entry: (candidateId: string, fromCandidateId: string) => AuditRecord; run: (r: PromoteResultDto) => AuditRecord },
  ): Promise<PromoteResultDto>;
}

// ---- mappers (also used by the jobRoles module) -----------------------------------

export const toCollegeDto = (c: CollegeRow): CollegeDto => ({ ...c });

export const toDriveDto = (d: DriveRow): DriveDto => ({
  id: d.id,
  roundId: d.roundId,
  roundNumber: d.roundNumber,
  jobRoleId: d.jobRoleId,
  jobRoleName: d.jobRoleName,
  jobProfileType: d.jobProfileType,
  college: d.college,
  batch: d.batch,
  displayName: driveDisplayName({ jobRoleName: d.jobRoleName, roundNumber: d.roundNumber, collegeShortCode: d.college.shortCode, batch: d.batch }),
  windowStart: d.windowStart?.toISOString() ?? null,
  windowEnd: d.windowEnd?.toISOString() ?? null,
  isOpen: d.isOpen,
  instructions: d.instructions,
  active: d.active,
  counts: { candidates: d.candidateCount, started: d.startedCount },
});

/** `drives` undefined = omit the key (Evaluators never receive drives). */
export const toRoundDto = (r: RoundRow, drives?: DriveRow[]): RoundDto => ({
  id: r.id,
  roundNumber: r.roundNumber,
  name: r.name,
  durationMinutes: r.durationMinutes,
  questionsLocked: r.questionsLocked,
  weights: { exam: r.weightExam, x: r.weightX, xii: r.weightXii, cpi: r.weightCpi },
  mcqNegativeMarks: r.mcqNegativeMarks,
  counts: { questions: r.questionCount },
  ...(drives ? { drives: drives.map(toDriveDto) } : {}),
});

const instant = (v: string | null | undefined): Date | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(v));

export function createDrivesService(repo: DrivesRepository) {
  const audit = (actor: Actor, action: string, entity: string, entityId: string, metadata: Record<string, unknown>): AuditRecord => ({
    adminId: actor.id,
    action,
    entity,
    entityId,
    metadata,
    ip: actor.ip,
  });

  // ---- colleges ----
  async function listColleges(): Promise<CollegeDto[]> {
    return (await repo.listColleges()).map(toCollegeDto);
  }

  async function createCollege(input: CollegeCreateInput, actor: Actor): Promise<CollegeDto> {
    const row = await repo.createCollege(input, (id) => audit(actor, 'COLLEGE_CREATED', 'college', id, { name: input.name, shortCode: input.shortCode }));
    return toCollegeDto(row);
  }

  async function updateCollege(id: string, input: CollegeUpdateInput, actor: Actor): Promise<CollegeDto> {
    if (!(await repo.findCollege(id))) throw notFound('College not found');
    const row = await repo.updateCollege(id, input, audit(actor, 'COLLEGE_UPDATED', 'college', id, { ...input }));
    return toCollegeDto(row);
  }

  // ---- rounds ----
  async function addRound(jobRoleId: string, input: RoundCreateInput, actor: Actor): Promise<RoundDto> {
    if (!(await repo.roleExists(jobRoleId))) throw notFound('Job profile not found');
    const row = await repo.addRound(jobRoleId, input.name ?? null, (id, roundNumber) =>
      audit(actor, 'ROUND_CREATED', 'exam_round', id, { jobRoleId, roundNumber }),
    );
    return toRoundDto(row, []);
  }

  async function updateRound(id: string, input: RoundSettingsInput, actor: Actor): Promise<RoundDto> {
    const round = await repo.findRound(id);
    if (!round) throw notFound('Round not found');
    const negative = input.mcqNegativeMarks;
    // Checked under the round row lock (review I1): a start that locks the round between a read
    // here and the write cannot be missed, so every candidate of a round has the same penalty.
    const guard =
      negative === undefined
        ? undefined
        : (current: RoundGuardState) => {
            if (negative === current.mcqNegativeMarks) return;
            // Frozen with the question lock: every college's drive of the round keeps the same penalty.
            if (current.questionsLocked) {
              throw new AppError(423, 'QUESTIONS_LOCKED', 'Negative marking is locked because candidates have started this round.');
            }
            if (current.minMcqMarks !== null && negative > current.minMcqMarks) {
              throw badRequest(`Negative marking can be at most ${current.minMcqMarks} (the smallest MCQ marks in this round).`);
            }
          };
    const data: RoundWrite = {
      durationMinutes: input.durationMinutes,
      ...(input.mcqNegativeMarks !== undefined ? { mcqNegativeMarks: input.mcqNegativeMarks } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.weights ? { weights: input.weights } : {}),
    };
    const row = await repo.updateRound(
      id,
      data,
      audit(actor, 'ROUND_UPDATED', 'exam_round', id, {
        durationMinutes: data.durationMinutes,
        ...(data.weights ? { weights: data.weights } : {}),
        ...(data.mcqNegativeMarks !== undefined ? { mcqNegativeMarks: data.mcqNegativeMarks } : {}),
      }),
      guard,
    );
    return toRoundDto(row);
  }

  // ---- drives ----
  async function listDrives(q: DriveListQuery): Promise<DriveDto[]> {
    return (await repo.listDrives(q)).map(toDriveDto);
  }

  async function createDrive(roundId: string, input: DriveCreateInput, actor: Actor): Promise<DriveDto> {
    if (!(await repo.findRound(roundId))) throw notFound('Round not found');
    const college = await repo.findCollege(input.collegeId);
    if (!college) throw notFound('College not found');
    if (!college.active) throw conflict('This college is inactive. Activate it before adding a drive.', 'COLLEGE_INACTIVE');
    const row = await repo.createDrive(
      {
        roundId,
        collegeId: input.collegeId,
        batch: input.batch,
        windowStart: instant(input.windowStart) ?? null,
        windowEnd: instant(input.windowEnd) ?? null,
        instructions: input.instructions,
        isOpen: input.isOpen,
      },
      (id) => audit(actor, 'DRIVE_CREATED', 'drive', id, { roundId, collegeId: input.collegeId, batch: input.batch, isOpen: input.isOpen }),
    );
    return toDriveDto(row);
  }

  async function updateDrive(id: string, input: DriveUpdateInput, actor: Actor): Promise<DriveDto> {
    const current = await repo.findDrive(id);
    if (!current) throw notFound('Drive not found');
    // The batch ties a drive to the "one person per round and batch" rule and pairs it
    // with the next round's drive for promotion; once people are in it, it stays.
    if (input.batch !== undefined && input.batch.trim().toLowerCase() !== current.batch.toLowerCase() && current.candidateCount > 0) {
      throw conflict("This drive already has candidates, so its batch can't change. Create a new drive for another batch.");
    }
    const data: DriveWrite = {
      ...(input.batch !== undefined ? { batch: input.batch } : {}),
      ...(input.windowStart !== undefined ? { windowStart: instant(input.windowStart) } : {}),
      ...(input.windowEnd !== undefined ? { windowEnd: instant(input.windowEnd) } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.isOpen !== undefined ? { isOpen: input.isOpen } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    };
    const row = await repo.updateDrive(
      id,
      data,
      audit(actor, 'DRIVE_UPDATED', 'drive', id, {
        fields: Object.keys(data),
        ...(data.batch !== undefined ? { batch: data.batch } : {}),
        ...(data.windowStart !== undefined ? { windowStart: data.windowStart?.toISOString() ?? null } : {}),
        ...(data.windowEnd !== undefined ? { windowEnd: data.windowEnd?.toISOString() ?? null } : {}),
        ...(data.isOpen !== undefined ? { isOpen: data.isOpen } : {}),
        ...(data.active !== undefined ? { active: data.active } : {}),
        ...(data.instructions !== undefined ? { instructionsLength: data.instructions.length } : {}),
      }),
    );
    return toDriveDto(row);
  }

  /** "Move shortlisted to Round n+1": the same college and batch, the next round. */
  async function promote(driveId: string, actor: Actor): Promise<PromoteResultDto> {
    const source = await repo.findDrive(driveId);
    if (!source) throw notFound('Drive not found');
    const next = await repo.nextRound(source.roundId);
    if (!next) throw conflict(`This job profile has no Round ${source.roundNumber + 1} yet. Add it first.`, 'NEXT_ROUND_MISSING');
    const target = await repo.findDriveFor(next.id, source.college.id, source.batch);
    if (!target) {
      throw new AppError(409, 'NEXT_DRIVE_MISSING', `There is no Round ${source.roundNumber + 1} drive for ${source.college.shortCode} · ${source.batch} yet.`, {
        roundId: next.id,
        collegeId: source.college.id,
        batch: source.batch,
      });
    }
    if (!target.active) throw conflict('The next round\'s drive is inactive. Activate it first.');
    return repo.promote(source.id, target, {
      entry: (candidateId, fromCandidateId) =>
        audit(actor, 'CANDIDATE_PROMOTED', 'candidate', candidateId, { fromCandidateId, fromDriveId: source.id, toDriveId: target.id }),
      run: (r) => audit(actor, 'DRIVE_PROMOTED', 'drive', source.id, { toDriveId: target.id, moved: r.moved, alreadyThere: r.alreadyThere, skipped: r.skipped.length }),
    });
  }

  return { listColleges, createCollege, updateCollege, addRound, updateRound, listDrives, createDrive, updateDrive, promote };
}

export type DrivesService = ReturnType<typeof createDrivesService>;
