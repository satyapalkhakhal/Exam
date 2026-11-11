import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollegeCreateSchema, DriveCreateSchema, driveDisplayName } from '../src/schemas/drives.js';
import { AiRunStartSchema } from '../src/schemas/aiEvaluation.js';

const uuid = '11111111-1111-4111-8111-111111111111';

test('driveDisplayName formats exactly', () => {
  assert.equal(
    driveDisplayName({ jobRoleName: 'Quant Analyst', roundNumber: 1, collegeShortCode: 'IITG', batch: 'Nov 2026' }),
    'Quant Analyst · Round 1 · IITG · Nov 2026',
  );
});

test('CollegeCreateSchema upper-cases short code and rejects "ii t"', () => {
  assert.deepEqual(CollegeCreateSchema.parse({ name: ' IIT Guwahati ', shortCode: 'iitg' }), { name: 'IIT Guwahati', shortCode: 'IITG' });
  assert.equal(CollegeCreateSchema.safeParse({ name: 'X', shortCode: 'ii t' }).success, false);
  assert.equal(CollegeCreateSchema.safeParse({ name: 'X', shortCode: 'A' }).success, false);
  assert.equal(CollegeCreateSchema.safeParse({ name: 'X', shortCode: 'ABCDEFGHIJKLM' }).success, false);
  assert.equal(CollegeCreateSchema.safeParse({ name: '', shortCode: 'NITT' }).success, false);
});

test('DriveCreateSchema trims batch, rejects empty and >60 chars, rejects end ≤ start', () => {
  const base = { collegeId: uuid, instructions: '', isOpen: false };
  assert.equal(DriveCreateSchema.parse({ ...base, batch: '  Nov 2026 ' }).batch, 'Nov 2026');
  assert.equal(DriveCreateSchema.safeParse({ ...base, batch: '   ' }).success, false);
  assert.equal(DriveCreateSchema.safeParse({ ...base, batch: 'x'.repeat(61) }).success, false);
  const t = '2026-11-10T04:00:00.000Z';
  assert.equal(DriveCreateSchema.safeParse({ ...base, batch: 'B', windowStart: t, windowEnd: t }).success, false);
  assert.equal(DriveCreateSchema.safeParse({ ...base, batch: 'B', windowStart: t, windowEnd: '2026-11-10T10:00:00.000Z' }).success, true);
});

test('AiRunStartSchema needs exactly one of driveId/attemptIds', () => {
  assert.equal(AiRunStartSchema.safeParse({ driveId: uuid }).success, true);
  assert.equal(AiRunStartSchema.safeParse({ attemptIds: [uuid] }).success, true);
  assert.equal(AiRunStartSchema.safeParse({}).success, false);
  assert.equal(AiRunStartSchema.safeParse({ driveId: uuid, attemptIds: [uuid] }).success, false);
});
