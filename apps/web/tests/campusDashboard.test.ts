import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DashboardDriveDto } from '@exam/shared';
import {
  DEFAULT_DASH_FILTERS,
  PERFORMANCE_THRESHOLDS,
  applyFilters,
  avgExamPct,
  byInstitution,
  candidatesLink,
  filterOptions,
  institutionCount,
  institutionProfileMatrix,
  institutionStatusRows,
  internshipRows,
  performanceTag,
  profileRows,
  rankingGroups,
  selectionPct,
  showOneInstitutionNote,
  submissionsLink,
  toCsv,
  totals,
  type DashFilters,
} from '../src/lib/campusDashboard.js';

const row = (over: Partial<DashboardDriveDto> & Pick<DashboardDriveDto, 'driveId'>): DashboardDriveDto => ({
  displayName: 'x',
  jobRoleId: 'j1',
  jobRoleName: 'Backend',
  jobProfileType: 'PLACEMENT',
  roundNumber: 1,
  collegeShortCode: 'IITG',
  batch: 'Nov 2026',
  refApplicantCount: 0,
  imported: 0,
  notStarted: 0,
  inProgress: 0,
  submitted: 0,
  autoSubmitted: 0,
  evaluated: 0,
  shortlisted: 0,
  rejected: 0,
  pendingEvaluation: 0,
  collegeId: 'c1',
  collegeName: 'IIT Guwahati',
  roundId: 'r1',
  examPctSum: 0,
  examPctCount: 0,
  ...over,
});

const NITT = { collegeId: 'c2', collegeName: 'NIT Trichy', collegeShortCode: 'NITT' };
// d1: IITG Backend placement R1 · d2: its Round 2 (3 promoted candidates) · d3: NITT QA internship · d4: NITT Backend placement
const ROWS: DashboardDriveDto[] = [
  row({ driveId: 'd1', imported: 10, notStarted: 2, inProgress: 1, submitted: 1, evaluated: 1, shortlisted: 3, rejected: 2, pendingEvaluation: 1, examPctSum: 400, examPctCount: 5 }),
  row({ driveId: 'd2', roundNumber: 2, roundId: 'r2', imported: 3, notStarted: 1, evaluated: 2, examPctSum: 150, examPctCount: 2 }),
  row({ driveId: 'd3', ...NITT, jobRoleId: 'j2', jobRoleName: 'QA', jobProfileType: 'INTERNSHIP', roundId: 'r3', imported: 6, notStarted: 1, submitted: 2, shortlisted: 2, rejected: 1, pendingEvaluation: 2, examPctSum: 210, examPctCount: 3 }),
  row({ driveId: 'd4', ...NITT, imported: 4, evaluated: 2, shortlisted: 1, rejected: 1, examPctSum: 340, examPctCount: 4 }),
];
const ALL_ROUNDS: DashFilters = { ...DEFAULT_DASH_FILTERS, roundNumber: '' };
const isClean = (v: unknown): boolean => !/NaN|Infinity/.test(JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)));

test('default round filter counts a promoted candidate once', () => {
  assert.equal(DEFAULT_DASH_FILTERS.roundNumber, '1');
  assert.equal(totals(applyFilters(ROWS, DEFAULT_DASH_FILTERS)).applications, 20);
  assert.equal(totals(applyFilters(ROWS, ALL_ROUNDS)).applications, 23);
});

test('funnel stages: submitted and evaluated are reached-stage counts, pending is the difference', () => {
  const t = totals(applyFilters(ROWS, DEFAULT_DASH_FILTERS));
  assert.deepEqual(
    { ns: t.notStarted, ip: t.inProgress, sub: t.submitted, ev: t.evaluated, pend: t.pending, sel: t.selected, rej: t.rejected },
    { ns: 3, ip: 1, sub: 16, ev: 13, pend: 3, sel: 6, rej: 4 },
  );
  assert.ok(t.selected + t.rejected <= t.evaluated);
});

test('avg exam % is weighted by evaluated count across drives', () => {
  // IITG under "All rounds": (400 + 150) / 7 = 78.57, not the mean of 80 and 75.
  const iitg = totals(applyFilters(ROWS, { ...ALL_ROUNDS, collegeId: 'c1' }));
  assert.equal(avgExamPct(iitg), 78.57);
  assert.equal(avgExamPct(totals(applyFilters(ROWS, DEFAULT_DASH_FILTERS))), 79.17);
});

test('selection % is of the decided; dash when none decided', () => {
  assert.equal(selectionPct(totals(applyFilters(ROWS, DEFAULT_DASH_FILTERS))), 60);
  assert.equal(selectionPct(totals(applyFilters(ROWS, { ...ALL_ROUNDS, roundNumber: '2' }))), null);
});

test('ranking groups by profile and programme; ranks by avg then selection %; tags at 84/78', () => {
  assert.deepEqual(PERFORMANCE_THRESHOLDS, { strong: 84, good: 78 });
  const groups = rankingGroups(applyFilters(ROWS, DEFAULT_DASH_FILTERS));
  assert.deepEqual(
    groups.map((g) => [g.profile, g.programme, g.items.map((i) => [i.rank, i.name, i.avgExamPct, i.selectionPct, i.tag])]),
    [
      ['Backend', 'PLACEMENT', [[1, 'NIT Trichy', 85, 50, 'Strong'], [2, 'IIT Guwahati', 80, 60, 'Good']]],
      ['QA', 'INTERNSHIP', [[1, 'NIT Trichy', 70, 66.7, 'Needs review']]],
    ],
  );
  // Equal averages: the higher selection % ranks first; no evaluated candidate → no tag, ranked last.
  const tie = [
    row({ driveId: 't1', collegeName: 'A College', collegeId: 'a', imported: 2, evaluated: 0, shortlisted: 1, rejected: 1, examPctSum: 160, examPctCount: 2 }),
    row({ driveId: 't2', collegeName: 'B College', collegeId: 'b', imported: 2, shortlisted: 2, examPctSum: 160, examPctCount: 2 }),
    row({ driveId: 't3', collegeName: 'C College', collegeId: 'c', imported: 2, notStarted: 2 }),
  ];
  assert.deepEqual(rankingGroups(tie)[0]!.items.map((i) => [i.name, i.tag]), [['B College', 'Good'], ['A College', 'Good'], ['C College', null]]);
  assert.equal(performanceTag(84), 'Strong');
  assert.equal(performanceTag(77.99), 'Needs review');
  assert.equal(performanceTag(null), null);
});

test('filter options list only values present; empty selection yields zeros and dashes', () => {
  assert.deepEqual(filterOptions(ROWS), {
    batches: ['Nov 2026'],
    colleges: [{ id: 'c1', name: 'IIT Guwahati' }, { id: 'c2', name: 'NIT Trichy' }],
    profiles: [{ id: 'j1', name: 'Backend' }, { id: 'j2', name: 'QA' }],
    rounds: [1, 2],
  });
  const none = applyFilters(ROWS, { ...DEFAULT_DASH_FILTERS, collegeId: 'nope' });
  assert.deepEqual(none, []);
  const t = totals(none);
  assert.equal(t.applications, 0);
  assert.equal(avgExamPct(t), null);
  assert.equal(selectionPct(t), null);
  for (const v of [t, byInstitution(none), institutionProfileMatrix(none), institutionStatusRows(none), profileRows(none), internshipRows(none), rankingGroups(none)]) {
    assert.ok(isClean(v), JSON.stringify(v));
  }
  assert.deepEqual(rankingGroups(none), []);
  assert.equal(institutionCount(none), 0);
  assert.deepEqual(filterOptions([]), { batches: [], colleges: [], profiles: [], rounds: [] });
});

test('matrix and status rows sum to the totals', () => {
  const rows = applyFilters(ROWS, DEFAULT_DASH_FILTERS);
  const t = totals(rows);
  const m = institutionProfileMatrix(rows);
  assert.deepEqual(m.profiles, ['Backend', 'QA']);
  assert.deepEqual(m.rows.map((r) => [r.name, r.programme, r.perProfile, r.total]), [
    ['IIT Guwahati', 'PLACEMENT', [10, 0], 10],
    ['NIT Trichy', 'INTERNSHIP', [0, 6], 6],
    ['NIT Trichy', 'PLACEMENT', [4, 0], 4],
  ]);
  assert.equal(m.rows.reduce((a, r) => a + r.total, 0), t.applications);
  const s = institutionStatusRows(rows);
  for (const k of ['applications', 'notStarted', 'inProgress', 'submitted', 'pending', 'evaluated', 'selected', 'rejected'] as const) {
    assert.equal(s.reduce((a, r) => a + r[k], 0), t[k], k);
  }
  assert.deepEqual(byInstitution(rows), [{ collegeId: 'c2', name: 'NIT Trichy', applications: 10 }, { collegeId: 'c1', name: 'IIT Guwahati', applications: 10 }].sort((a, b) => b.applications - a.applications || a.name.localeCompare(b.name)));
  assert.equal(institutionCount(rows), 2);
  assert.equal(institutionCount(applyFilters(ROWS, { ...DEFAULT_DASH_FILTERS, collegeId: 'c1' })), 1);
  assert.deepEqual(internshipRows(rows).map((r) => [r.institution, r.profile, r.applications, r.selectionPct]), [['NIT Trichy', 'QA', 6, 66.7]]);
  assert.deepEqual(profileRows(rows).map((r) => [r.profile, r.institution, r.programme, r.avgExamPct]), [
    ['Backend', 'NIT Trichy', 'PLACEMENT', 85],
    ['Backend', 'IIT Guwahati', 'PLACEMENT', 80],
    ['QA', 'NIT Trichy', 'INTERNSHIP', 70],
  ]);
});

test('csv escapes formula-leading cells and quotes', () => {
  assert.equal(
    toCsv(['Name', 'N'], [['=HYPERLINK("x")', 1], ['A "q"', null], ['+1', -5], ['@x', 0]]),
    ['"Name","N"', `"'=HYPERLINK(""x"")","1"`, '"A ""q""",""', `"'+1","-5"`, `"'@x","0"`].join('\r\n'),
  );
});

test('links carry the current filters and omit empty ones', () => {
  const f: DashFilters = { batch: 'Nov 2026', collegeId: 'c1', jobRoleId: '', programme: 'PLACEMENT', roundNumber: '1' };
  assert.equal(candidatesLink(f), '/admin/candidates?collegeId=c1&batch=Nov+2026&jobProfileType=PLACEMENT&roundNumber=1');
  assert.equal(submissionsLink(f), '/admin/submissions?collegeId=c1&batch=Nov+2026&jobProfileType=PLACEMENT&roundNumber=1');
  assert.equal(candidatesLink({ batch: '', collegeId: '', jobRoleId: '', programme: '', roundNumber: '' }), '/admin/candidates');
});

test('batch matches like the list endpoints: ignoring case and spaces; one option per batch (review M-1)', () => {
  const rows = [
    row({ driveId: 'b1', batch: 'Nov 2026', imported: 2 }),
    row({ driveId: 'b2', ...NITT, batch: 'nov 2026', imported: 3 }),
    row({ driveId: 'b3', batch: 'Jan 2027', imported: 1 }),
  ];
  assert.deepEqual(filterOptions(rows).batches, ['Jan 2027', 'Nov 2026']);
  for (const b of ['Nov 2026', 'nov 2026', ' NOV 2026 ']) {
    assert.equal(totals(applyFilters(rows, { ...DEFAULT_DASH_FILTERS, batch: b })).applications, 5, b);
  }
});

test('ranking never mixes rounds: under "All rounds" each round is its own group (review M-2)', () => {
  const groups = rankingGroups(applyFilters(ROWS, ALL_ROUNDS));
  assert.deepEqual(
    groups.map((g) => [g.profile, g.programme, g.roundNumber, g.items.map((i) => [i.name, i.avgExamPct])]),
    [
      ['Backend', 'PLACEMENT', 1, [['NIT Trichy', 85], ['IIT Guwahati', 80]]],
      ['Backend', 'PLACEMENT', 2, [['IIT Guwahati', 75]]],
      ['QA', 'INTERNSHIP', 1, [['NIT Trichy', 70]]],
    ],
  );
});

test('one-institution note: only when the data has one college, not when the user picked one (review M-4)', () => {
  assert.equal(showOneInstitutionNote(DEFAULT_DASH_FILTERS, applyFilters(ROWS, DEFAULT_DASH_FILTERS)), false);
  const picked = { ...DEFAULT_DASH_FILTERS, collegeId: 'c1' };
  assert.equal(showOneInstitutionNote(picked, applyFilters(ROWS, picked)), false);
  const onlyIitg = ROWS.filter((r) => r.collegeId === 'c1');
  assert.equal(showOneInstitutionNote(DEFAULT_DASH_FILTERS, applyFilters(onlyIitg, DEFAULT_DASH_FILTERS)), true);
});
