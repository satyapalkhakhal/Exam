// "Move shortlisted to Round n+1" (spec 2026-11-10 §5.3) on a fake repository:
// the target is round n+1 of the same job profile, same college and batch;
// a missing round or drive is a 409 the web can act on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrivesService, type DriveRow, type DrivesRepository } from '../src/modules/drives/drives.service.js';

const actor = { id: 'admin', ip: null };
const drive = (over: Partial<DriveRow> = {}): DriveRow => ({
  id: 'd1', roundId: 'r1', roundNumber: 1, jobRoleId: 'j1', jobRoleName: 'Quant Analyst', jobProfileType: 'PLACEMENT',
  college: { id: 'c-iitg', name: 'IIT Guwahati', shortCode: 'IITG' }, batch: 'Nov 2026', windowStart: null, windowEnd: null,
  isOpen: false, instructions: '', active: true, candidateCount: 0, startedCount: 0, ...over,
});

function setup(over: Partial<DrivesRepository> = {}) {
  const lookups: [string, string, string][] = [];
  const promoted: string[] = [];
  const repo = {
    findDrive: async () => drive(),
    nextRound: async (roundId: string) => (roundId === 'r1' ? { id: 'r2' } : null),
    findDriveFor: async (roundId: string, collegeId: string, batch: string) => {
      lookups.push([roundId, collegeId, batch]);
      return drive({ id: 'd2', roundId: 'r2', roundNumber: 2 });
    },
    promote: async (sourceId: string, target: DriveRow) => {
      promoted.push(`${sourceId}->${target.id}`);
      return { targetDriveId: target.id, moved: 2, alreadyThere: 1, skipped: [] };
    },
    ...over,
  } as unknown as DrivesRepository;
  return { service: createDrivesService(repo), lookups, promoted };
}

test('promote picks round n+1 same college+batch', async () => {
  const { service, lookups, promoted } = setup();
  const res = await service.promote('d1', actor);
  assert.deepEqual(lookups, [['r2', 'c-iitg', 'Nov 2026']]);
  assert.deepEqual(promoted, ['d1->d2']);
  assert.deepEqual(res, { targetDriveId: 'd2', moved: 2, alreadyThere: 1, skipped: [] });
});

test('promote without a next round is 409 NEXT_ROUND_MISSING', async () => {
  const { service } = setup({ nextRound: async () => null });
  await assert.rejects(service.promote('d1', actor), (e: { statusCode: number; code: string }) => e.statusCode === 409 && e.code === 'NEXT_ROUND_MISSING');
});

test('promote without the next drive is 409 NEXT_DRIVE_MISSING with what to create', async () => {
  const { service } = setup({ findDriveFor: async () => null });
  await assert.rejects(service.promote('d1', actor), (e: { statusCode: number; code: string; details: unknown }) => {
    assert.equal(e.code, 'NEXT_DRIVE_MISSING');
    assert.deepEqual(e.details, { roundId: 'r2', collegeId: 'c-iitg', batch: 'Nov 2026' });
    return e.statusCode === 409;
  });
});
