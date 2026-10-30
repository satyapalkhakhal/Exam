// Row mapping, validation and duplicate detection for the candidate import,
// including HR's real sample row and the messy-spreadsheet cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateRows, TEMPLATE_COLUMNS, type ParseContext } from '../src/modules/candidates/candidateImport.parser.js';

const DEFAULT_ROLE = 'role-default';
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  defaultJobRoleId: DEFAULT_ROLE,
  rolesByLowerName: new Map([['analyst', 'role-analyst']]),
  existingEmails: new Set(),
  existingMobiles: new Set(),
  ...over,
});

const sample = {
  'schooling.x_percentage': '97.6',
  'schooling.xii_percentage': '99.8',
  roll_number: '254101009',
  name: 'AJITH K K',
  major_cpi: '8.67',
  'major.discipline': 'Computer Science and Engineering',
  'major.programme': 'M.Tech',
  email: 'k.ajith@iitg.ac.in',
};

test("HR's sample row maps exactly", () => {
  const r = parseCandidateRows([sample], ctx());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid.length, 1);
  const { row, ...draft } = r.valid[0]!;
  assert.equal(row, 2);
  assert.deepEqual(draft, {
    fullName: 'AJITH K K',
    email: 'k.ajith@iitg.ac.in',
    rollNumber: '254101009',
    xPercentage: 97.6,
    xiiPercentage: 99.8,
    majorCpi: 8.67,
    discipline: 'Computer Science and Engineering',
    programme: 'M.Tech',
    jobRoleId: DEFAULT_ROLE,
    mobile: null,
    extra: {},
  });
});

test('the same email in another case is an IN_FILE duplicate at row 3', () => {
  const r = parseCandidateRows([sample, { ...sample, email: 'K.Ajith@IITG.ac.in' }], ctx());
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
});

test('an email already in the database is EXISTS', () => {
  const r = parseCandidateRows([sample], ctx({ existingEmails: new Set(['k.ajith@iitg.ac.in']) }));
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.duplicates, [{ row: 2, reason: 'EXISTS' }]);
});

test('a repeated mobile is a duplicate in the file and against the database', () => {
  const a = { ...sample, mobile: '9876543210' };
  const b = { ...sample, email: 'b@x.in', mobile: '+91 98765 43210' };
  assert.deepEqual(parseCandidateRows([a, b], ctx()).duplicates, [{ row: 3, reason: 'IN_FILE' }]);
  assert.deepEqual(parseCandidateRows([b], ctx({ existingMobiles: new Set(['9876543210']) })).duplicates, [
    { row: 2, reason: 'EXISTS' },
  ]);
});

test('mobile +91 98765 43210 normalises to 9876543210; 091... and 91... too', () => {
  for (const raw of ['+91 98765 43210', '919876543210', '09876543210', '9876543210']) {
    const r = parseCandidateRows([{ ...sample, mobile: raw }], ctx());
    assert.equal(r.valid[0]?.mobile, '9876543210', raw);
  }
});

test('a mobile that is not 10 digits starting 6-9 is an error on mobile', () => {
  for (const raw of ['12345', '5876543210', '98765432101']) {
    const r = parseCandidateRows([{ ...sample, mobile: raw }], ctx());
    assert.equal(r.valid.length, 0, raw);
    assert.equal(r.errors[0]?.field, 'mobile');
  }
});

test('major_cpi 11 is an error on major_cpi', () => {
  const r = parseCandidateRows([{ ...sample, major_cpi: '11' }], ctx());
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.errors.map((e) => [e.row, e.field]), [[2, 'major_cpi']]);
});

test('percentages outside 0..100 are errors', () => {
  const r = parseCandidateRows([{ ...sample, 'schooling.x_percentage': '101', 'schooling.xii_percentage': '-1' }], ctx());
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ['schooling.x_percentage', 'schooling.xii_percentage']);
});

test('a job_role naming no known role is an error; a known one overrides the default', () => {
  const bad = parseCandidateRows([{ ...sample, job_role: 'Unknown' }], ctx());
  assert.deepEqual(bad.errors.map((e) => e.field), ['job_role']);
  const good = parseCandidateRows([{ ...sample, job_role: ' ANALYST ' }], ctx());
  assert.equal(good.valid[0]?.jobRoleId, 'role-analyst');
});

test('an unknown header goes to extra; blank unknown cells are dropped', () => {
  const r = parseCandidateRows([{ ...sample, hostel: 'Brahmaputra', notes: '' }], ctx());
  assert.deepEqual(r.valid[0]?.extra, { hostel: 'Brahmaputra' });
});

test('name and email are required; bad email and short name are errors', () => {
  const r = parseCandidateRows([{ ...sample, name: 'A', email: 'nope' }, { ...sample, name: '', email: '' }], ctx());
  assert.deepEqual(r.errors.map((e) => `${e.row}:${e.field}`).sort(), ['2:email', '2:name', '3:email', '3:name']);
});

test('the template carries the HR columns plus mobile and job_role', () => {
  assert.deepEqual([...TEMPLATE_COLUMNS], [
    'schooling.x_percentage', 'schooling.xii_percentage', 'roll_number', 'name', 'major_cpi',
    'major.discipline', 'major.programme', 'email', 'mobile', 'job_role',
  ]);
});

test('source row numbers are used for errors and duplicates when given (gap after a blank row)', () => {
  const rows = [sample, { ...sample, major_cpi: '11', email: 'b@x.in' }, { ...sample, email: 'K.AJITH@iitg.ac.in' }];
  const r = parseCandidateRows(rows, ctx(), [2, 5, 9]);
  assert.equal(r.valid[0]?.row, 2);
  assert.deepEqual(r.errors.map((e) => e.row), [5]);
  assert.deepEqual(r.duplicates, [{ row: 9, reason: 'IN_FILE' }]);
});

test('roll number, discipline and programme over 200 characters are errors, matching the edit schema', async () => {
  const long = 'x'.repeat(201);
  const r = parseCandidateRows([{ ...sample, roll_number: long, 'major.discipline': long, 'major.programme': long }], ctx());
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.errors.map((e) => e.field).sort(), ['major.discipline', 'major.programme', 'roll_number']);
  const ok = parseCandidateRows([{ ...sample, roll_number: 'x'.repeat(200) }], ctx());
  assert.equal(ok.valid.length, 1);

  const { CandidateUpdateSchema, CANDIDATE_TEXT_MAX } = await import('@exam/shared');
  assert.equal(CANDIDATE_TEXT_MAX, 200);
  for (const field of ['rollNumber', 'discipline', 'programme']) {
    assert.equal(CandidateUpdateSchema.safeParse({ [field]: long }).success, false, field);
    assert.equal(CandidateUpdateSchema.safeParse({ [field]: 'x'.repeat(200) }).success, true, field);
  }
});
