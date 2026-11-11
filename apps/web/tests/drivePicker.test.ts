import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DriveDto, JobRoleDto } from '@exam/shared';
import { drivesForRound, locateDrive, roundOptions, driveOptionLabel } from '../src/lib/drivePicker.js';

const drive = (over: Partial<DriveDto>): DriveDto => ({
  id: 'd', roundId: 'r1', roundNumber: 1, jobRoleId: 'j1', jobRoleName: 'Quant Analyst', jobProfileType: 'PLACEMENT',
  college: { id: 'c1', name: 'IIT Guwahati', shortCode: 'IITG' }, batch: 'Nov 2026', displayName: 'Quant Analyst · Round 1 · IITG · Nov 2026',
  windowStart: null, windowEnd: null, isOpen: false, instructions: '', active: true, counts: { candidates: 0, started: 0 }, ...over,
});
const role = (over: Partial<JobRoleDto>): JobRoleDto => ({
  id: 'j1', name: 'Quant Analyst', type: 'PLACEMENT', refApplicantCount: 0, active: true, counts: { candidates: 0 }, rounds: [], ...over,
});
const round = (id: string, n: number, drives: DriveDto[] = []) => ({
  id, roundNumber: n, name: null, durationMinutes: 60, questionsLocked: false, mcqNegativeMarks: 0, weights: { exam: 70, x: 10, xii: 10, cpi: 10 }, counts: { questions: 0 }, drives,
});

test('drivesForRound hides inactive unless asked', () => {
  const ds = [drive({ id: 'a' }), drive({ id: 'b', active: false }), drive({ id: 'c', roundId: 'r2' })];
  assert.deepEqual(drivesForRound(ds, 'r1', false).map((d) => d.id), ['a']);
  assert.deepEqual(drivesForRound(ds, 'r1', true).map((d) => d.id), ['a', 'b']);
});

test('driveOptionLabel is college · batch, marking inactive', () => {
  assert.equal(driveOptionLabel(drive({})), 'IITG · Nov 2026');
  assert.equal(driveOptionLabel(drive({ active: false })), 'IITG · Nov 2026 (inactive)');
});

test('roundOptions labels every round, with the internship type', () => {
  const roles = [
    role({ id: 'j1', rounds: [round('r1', 1), round('r2', 2)] }),
    role({ id: 'j2', name: 'Quant Analyst', type: 'INTERNSHIP', rounds: [round('r3', 1)] }),
  ];
  assert.deepEqual(roundOptions(roles), [
    { id: 'r1', jobRoleId: 'j1', label: 'Quant Analyst · Round 1' },
    { id: 'r2', jobRoleId: 'j1', label: 'Quant Analyst · Round 2' },
    { id: 'r3', jobRoleId: 'j2', label: 'Quant Analyst (Internship) · Round 1' },
  ]);
});

test('locateDrive finds the job profile and round of a drive id', () => {
  const d = drive({ id: 'dx', roundId: 'r2' });
  const roles = [role({ id: 'j1', rounds: [round('r1', 1), round('r2', 2, [d])] })];
  assert.deepEqual(locateDrive(roles, 'dx'), { jobRoleId: 'j1', roundId: 'r2', drive: d });
  assert.equal(locateDrive(roles, 'nope'), null);
});

test('batchOf reads the batch after the college code, even when names contain " · "', async () => {
  const { batchOf } = await import('../src/lib/drivePicker.js');
  assert.equal(batchOf('Quant · Analyst · Round 1 · IITG · Nov 2026', 'IITG'), 'Nov 2026');
  assert.equal(batchOf('Quant Analyst · Round 2 · NITT · Nov 2026 – Session 2', 'NITT'), 'Nov 2026 – Session 2');
});

test('copyResultText says how many questions were copied', async () => {
  const { copyResultText } = await import('../src/lib/drivePicker.js');
  assert.equal(copyResultText({ copied: 1, skippedDuplicates: 0 }), '1 question copied.');
  assert.equal(copyResultText({ copied: 12, skippedDuplicates: 0 }), '12 questions copied.');
  assert.equal(copyResultText({ copied: 0, skippedDuplicates: 0 }), 'The source round has no active questions; nothing was copied.');
});
