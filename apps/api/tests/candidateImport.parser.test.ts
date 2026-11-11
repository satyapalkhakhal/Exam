// Row mapping, validation and duplicate detection for the candidate import,
// including HR's real sample row and the messy-spreadsheet cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidateRows, TEMPLATE_COLUMNS, type ExistingAccount, type ParseContext } from '../src/modules/candidates/candidateImport.parser.js';

const DEFAULT_ROLE = 'role-default';
const DRIVE = 'drive-iitg';
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  driveId: DRIVE,
  jobRoleId: DEFAULT_ROLE,
  accountsByEmail: new Map(),
  mobileOwners: new Map(),
  ...over,
});

/** entries: driveId -> status of the person's entry in that drive. */
const account = (entries: Record<string, string> = {}, over: Partial<ExistingAccount> = {}): ExistingAccount => ({
  accountId: 'acc-1',
  mobile: null,
  entries: new Map(Object.entries(entries).map(([drive, status], i) => [drive, { id: `cand-${i + 1}`, status }])),
  sibling: null,
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
    driveId: DRIVE,
    mobile: null,
    extra: {},
  });
});

test('the same email in another case is an IN_FILE duplicate at row 3', () => {
  const r = parseCandidateRows([sample, { ...sample, email: 'K.Ajith@IITG.ac.in' }], ctx());
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
});

test('an email already in this drive in the database is EXISTS', () => {
  const r = parseCandidateRows([sample], ctx({ accountsByEmail: new Map([['k.ajith@iitg.ac.in', account({ [DRIVE]: 'NOT_STARTED' })]]) }));
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.duplicates, [{ row: 2, reason: 'EXISTS' }]);
});

test('a repeated mobile is a duplicate in the file and against the database', () => {
  const a = { ...sample, mobile: '9876543210' };
  const b = { ...sample, email: 'b@x.in', mobile: '+91 98765 43210' };
  assert.deepEqual(parseCandidateRows([a, b], ctx()).duplicates, [{ row: 3, reason: 'IN_FILE' }]);
  assert.deepEqual(parseCandidateRows([b], ctx({ mobileOwners: new Map([['9876543210', 'acc-9']]) })).duplicates, [
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

test('job role column ignored → goes to extra (one file = one drive)', () => {
  const r = parseCandidateRows([{ ...sample, job_role: 'Analyst' }], ctx());
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid[0]?.jobRoleId, DEFAULT_ROLE);
  assert.equal(r.valid[0]?.driveId, DRIVE);
  assert.deepEqual(r.valid[0]?.extra, { job_role: 'Analyst' });
});

test('an unknown header goes to extra; blank unknown cells are dropped', () => {
  const r = parseCandidateRows([{ ...sample, hostel: 'Brahmaputra', notes: '' }], ctx());
  assert.deepEqual(r.valid[0]?.extra, { hostel: 'Brahmaputra' });
});

test('name and email are required; bad email and short name are errors', () => {
  const r = parseCandidateRows([{ ...sample, name: 'A', email: 'nope' }, { ...sample, name: '', email: '' }], ctx());
  assert.deepEqual(r.errors.map((e) => `${e.row}:${e.field}`).sort(), ['2:email', '2:name', '3:email', '3:name']);
});

test('the template carries the HR columns plus mobile (no job_role: the drive is chosen for the file)', () => {
  assert.deepEqual([...TEMPLATE_COLUMNS], [
    'schooling.x_percentage', 'schooling.xii_percentage', 'roll_number', 'name', 'major_cpi',
    'major.discipline', 'major.programme', 'email', 'mobile',
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

// --- Several drives per person -----------------------------------------------------

test('row for a person already in a sibling drive → SAME_ROUND_BATCH error', () => {
  const r = parseCandidateRows(
    [sample],
    ctx({ accountsByEmail: new Map([[sample.email, account({ 'drive-nitt': 'NOT_STARTED' }, { sibling: { collegeShortCode: 'NITT', batch: 'Nov 2026' } })]]) }),
  );
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.errors, [{ row: 2, field: 'email', message: "Already in NITT's Nov 2026 drive for this round" }]);
});

test('same person, other batch → valid (links to the existing account)', () => {
  const r = parseCandidateRows([sample], ctx({ accountsByEmail: new Map([[sample.email, account({ 'drive-last-year': 'SUBMITTED' })]]) }));
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.linkedRows, [2]);
});

test('an existing account without an entry in this drive links: valid, and listed in linkedRows', () => {
  const r = parseCandidateRows([sample], ctx({ accountsByEmail: new Map([[sample.email, account({ 'drive-other': 'SUBMITTED' })]]) }));
  assert.equal(r.valid.length, 1);
  assert.deepEqual(r.linkedRows, [2]);
  assert.deepEqual(r.duplicates, []);
});

test('a brand new email is not linked', () => {
  assert.deepEqual(parseCandidateRows([sample], ctx()).linkedRows, []);
});

test('linking with a mobile owned by a different account is an error on mobile', () => {
  const r = parseCandidateRows(
    [{ ...sample, mobile: '9876543210' }],
    ctx({ accountsByEmail: new Map([[sample.email, account({ 'drive-other': 'SUBMITTED' })]]), mobileOwners: new Map([['9876543210', 'acc-9']]) }),
  );
  assert.equal(r.valid.length, 0);
  assert.deepEqual(r.errors.map((e) => [e.row, e.field]), [[2, 'mobile']]);
});

test("linking with the account's own mobile is fine", () => {
  const r = parseCandidateRows(
    [{ ...sample, mobile: '9876543210' }],
    ctx({ accountsByEmail: new Map([[sample.email, account({ 'drive-other': 'SUBMITTED' }, { mobile: '9876543210' })]]), mobileOwners: new Map([['9876543210', 'acc-1']]) }),
  );
  assert.equal(r.valid.length, 1);
});

// --- "Update existing candidates" mode ------------------------------------------

const updateCtx = (people: Record<string, ExistingAccount>, mobileOwners: Record<string, string> = {}) =>
  ctx({ accountsByEmail: new Map(Object.entries(people)), mobileOwners: new Map(Object.entries(mobileOwners)), updateExisting: true });

test('without updateExisting an existing email in this drive stays an EXISTS duplicate', () => {
  const r = parseCandidateRows([sample], ctx({ accountsByEmail: new Map([[sample.email, account({ [DRIVE]: 'NOT_STARTED' })]]) }));
  assert.deepEqual(r.duplicates, [{ row: 2, reason: 'EXISTS' }]);
  assert.deepEqual(r.updates, []);
});

test('updateExisting: an existing not-started entry (email + drive) becomes an update; blanks keep values', () => {
  const r = parseCandidateRows([{ ...sample, major_cpi: '', 'major.programme': '' }], updateCtx({ [sample.email]: account({ [DRIVE]: 'NOT_STARTED' }) }));
  assert.deepEqual(r.valid, []);
  assert.deepEqual(r.duplicates, []);
  assert.equal(r.updates.length, 1);
  const u = r.updates[0]!;
  assert.equal(u.candidateId, 'cand-1');
  assert.equal(u.jobRoleId, DEFAULT_ROLE);
  assert.equal(u.fullName, 'AJITH K K');
  assert.equal(u.xPercentage, 97.6);
  assert.equal(u.majorCpi, null, 'blank cell → null → keep existing value');
  assert.equal(u.programme, null);
});

test('updateExisting: a person with an entry only in another drive links as a new entry instead of moving the old one', () => {
  const r = parseCandidateRows([sample], updateCtx({ [sample.email]: account({ 'drive-other': 'NOT_STARTED' }) }));
  assert.deepEqual(r.updates, []);
  assert.equal(r.valid[0]!.driveId, DRIVE);
  assert.deepEqual(r.linkedRows, [2]);
});

test('updateExisting: an application that has started is an error, not an update', () => {
  const r = parseCandidateRows([sample], updateCtx({ [sample.email]: account({ [DRIVE]: 'SUBMITTED' }) }));
  assert.deepEqual(r.updates, []);
  assert.deepEqual(r.errors, [{ row: 2, field: 'email', message: 'This candidate has already started an exam and cannot be updated by import' }]);
});

test("updateExisting: a mobile owned by another account is an error; the account's own mobile is fine", () => {
  const people = { [sample.email]: account({ [DRIVE]: 'NOT_STARTED' }) };
  const other = parseCandidateRows([{ ...sample, mobile: '9876543210' }], updateCtx(people, { '9876543210': 'acc-2' }));
  assert.deepEqual(other.errors, [{ row: 2, field: 'mobile', message: 'This mobile belongs to another candidate' }]);
  const own = parseCandidateRows([{ ...sample, mobile: '9876543210' }], updateCtx(people, { '9876543210': 'acc-1' }));
  assert.equal(own.updates.length, 1);
  assert.equal(own.updates[0]!.mobile, '9876543210');
});

test('updateExisting: the same email twice in one file → second is an IN_FILE duplicate', () => {
  const r = parseCandidateRows([sample, sample], updateCtx({ [sample.email]: account({ [DRIVE]: 'NOT_STARTED' }) }));
  assert.equal(r.updates.length, 1);
  assert.deepEqual(r.duplicates, [{ row: 3, reason: 'IN_FILE' }]);
});

test('updateExisting: new emails are still created as usual alongside updates', () => {
  const r = parseCandidateRows([sample, { ...sample, email: 'new@iitg.ac.in', roll_number: '1' }], updateCtx({ [sample.email]: account({ [DRIVE]: 'NOT_STARTED' }) }));
  assert.equal(r.updates.length, 1);
  assert.equal(r.valid.length, 1);
  assert.equal(r.valid[0]!.email, 'new@iitg.ac.in');
});
