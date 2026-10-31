import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoundSettingsSchema, ExamStartSchema, CandidateCreateSchema, RegistrationCreateSchema } from '../src/index.js';

const UUID = '3f6c1a52-8d0e-4b7a-9c11-2e5d7a9b0c41';
const base = { durationMinutes: 60, instructions: '', isOpen: false };

test('round settings reject end before start', () => {
  const r = RoundSettingsSchema.safeParse({
    ...base,
    windowStart: '2026-11-02T10:00:00Z',
    windowEnd: '2026-11-02T09:00:00Z',
  });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.deepEqual(r.error.issues[0]?.path, ['windowEnd']);
    assert.equal(r.error.issues[0]?.message, 'Window end must be after window start');
  }
  assert.equal(
    RoundSettingsSchema.safeParse({ ...base, windowStart: '2026-11-02T10:00:00Z', windowEnd: '2026-11-02T11:00:00Z' }).success,
    true,
  );
});

test('start requires roundEntryId', () => {
  const location = { permission: 'DENIED' };
  const missing = ExamStartSchema.safeParse({ location });
  assert.equal(missing.success, false);
  if (!missing.success) assert.deepEqual(missing.error.issues[0]?.path, ['roundEntryId']);
  assert.equal(ExamStartSchema.safeParse({ location, roundEntryId: 'nope' }).success, false);
  assert.equal(ExamStartSchema.safeParse({ location, roundEntryId: UUID }).success, true);
});

test('candidate create requires examId', () => {
  const body = { fullName: 'Asha Rao', email: 'asha@example.com' };
  const missing = CandidateCreateSchema.safeParse(body);
  assert.equal(missing.success, false);
  if (!missing.success) assert.deepEqual(missing.error.issues[0]?.path, ['examId']);
  assert.equal(CandidateCreateSchema.safeParse({ ...body, jobRoleId: UUID }).success, false);
  assert.equal(CandidateCreateSchema.safeParse({ ...body, examId: UUID }).success, true);
});

test('registration create requires uuid', () => {
  assert.equal(RegistrationCreateSchema.safeParse({}).success, false);
  assert.equal(RegistrationCreateSchema.safeParse({ examId: 'x' }).success, false);
  assert.deepEqual(RegistrationCreateSchema.parse({ examId: UUID }), { examId: UUID });
});
