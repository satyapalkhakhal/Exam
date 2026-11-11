// drives module service rules on a fake repository: round numbering, inactive
// colleges, the drive DTO (display name, counts) and round weights.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundSettingsSchema } from '@exam/shared';
import {
  createDrivesService,
  type CollegeRow,
  type DriveRow,
  type DrivesRepository,
  type RoundRow,
} from '../src/modules/drives/drives.service.js';

const actor = { id: 'admin', ip: null };
const college = (over: Partial<CollegeRow> = {}): CollegeRow => ({ id: 'c1', name: 'IIT Guwahati', shortCode: 'IITG', active: true, driveCount: 0, ...over });
const round = (over: Partial<RoundRow> = {}): RoundRow => ({
  id: 'r1', jobRoleId: 'j1', roundNumber: 1, name: null, durationMinutes: 60, questionsLocked: false,
  weightExam: 70, weightX: 10, weightXii: 10, weightCpi: 10, mcqNegativeMarks: 0, questionCount: 0, ...over,
});
const drive = (over: Partial<DriveRow> = {}): DriveRow => ({
  id: 'd1', roundId: 'r1', roundNumber: 1, jobRoleId: 'j1', jobRoleName: 'Quant Analyst', jobProfileType: 'PLACEMENT',
  college: { id: 'c1', name: 'IIT Guwahati', shortCode: 'IITG' }, batch: 'Nov 2026', windowStart: null, windowEnd: null,
  isOpen: false, instructions: '', active: true, candidateCount: 3, startedCount: 1, ...over,
});

function setup(over: Partial<DrivesRepository> = {}) {
  const calls: { addRound: number[]; createDrive: unknown[]; updateRound: unknown[] } = { addRound: [], createDrive: [], updateRound: [] };
  const repo: DrivesRepository = {
    listColleges: async () => [college()],
    findCollege: async () => college(),
    createCollege: async (data) => college({ ...data }),
    updateCollege: async (_id, data) => college({ ...data }),
    roleExists: async () => true,
    addRound: async (jobRoleId, _name, audit) => {
      const n = 2;
      calls.addRound.push(n);
      audit('r2', n);
      return round({ id: 'r2', jobRoleId, roundNumber: n });
    },
    findRound: async () => round(),
    updateRound: async (_id, data) => {
      calls.updateRound.push(data);
      return round({ durationMinutes: data.durationMinutes, ...(data.weights ? { weightExam: data.weights.exam, weightX: data.weights.x, weightXii: data.weights.xii, weightCpi: data.weights.cpi } : {}) });
    },
    listDrives: async () => [drive()],
    findDrive: async () => drive(),
    createDrive: async (data) => {
      calls.createDrive.push(data);
      return drive({ batch: data.batch });
    },
    updateDrive: async () => drive(),
    findDriveFor: async () => null,
    nextRound: async () => null,
    promote: async () => ({ targetDriveId: 'd2', moved: 0, alreadyThere: 0, skipped: [] }),
    ...over,
  };
  return { service: createDrivesService(repo), calls };
}

test('addRound numbers sequentially and audits the number', async () => {
  const { service, calls } = setup();
  const dto = await service.addRound('j1', { name: 'Interview prep' }, actor);
  assert.equal(dto.roundNumber, 2);
  assert.deepEqual(calls.addRound, [2]);
});

test('createDrive refuses an inactive college with COLLEGE_INACTIVE', async () => {
  const { service, calls } = setup({ findCollege: async () => college({ active: false }) });
  await assert.rejects(
    service.createDrive('r1', { collegeId: 'c1', batch: 'Nov 2026', instructions: '', isOpen: false }, actor),
    (e: { statusCode: number; code: string }) => e.statusCode === 409 && e.code === 'COLLEGE_INACTIVE',
  );
  assert.equal(calls.createDrive.length, 0);
});

test('DriveDto.displayName uses driveDisplayName and carries counts', async () => {
  const { service } = setup();
  const [dto] = await service.listDrives({});
  assert.equal(dto!.displayName, 'Quant Analyst · Round 1 · IITG · Nov 2026');
  assert.deepEqual(dto!.counts, { candidates: 3, started: 1 });
});

test('updateRound passes weights through when given, and omits them when not', async () => {
  const { service, calls } = setup();
  const dto = await service.updateRound('r1', { durationMinutes: 90, weights: { exam: 50, x: 20, xii: 20, cpi: 10 } }, actor);
  assert.deepEqual(dto.weights, { exam: 50, x: 20, xii: 20, cpi: 10 });
  await service.updateRound('r1', { durationMinutes: 90 }, actor);
  assert.equal((calls.updateRound[1] as { weights?: unknown }).weights, undefined);
});

test('RoundSettingsSchema rejects weights that do not add up to 100 or give the exam no weight', () => {
  const parse = (weights: unknown) => RoundSettingsSchema.safeParse({ durationMinutes: 60, weights }).success;
  assert.equal(parse({ exam: 70, x: 10, xii: 10, cpi: 10 }), true);
  assert.equal(parse({ exam: 70, x: 10, xii: 10, cpi: 5 }), false);
  assert.equal(parse({ exam: 0, x: 40, xii: 30, cpi: 30 }), false);
  assert.equal(RoundSettingsSchema.safeParse({ durationMinutes: 5 }).success, false);
});
