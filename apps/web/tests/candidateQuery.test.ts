import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateQuery, marksText, EMPTY_CANDIDATE_FILTERS, type CandidateFilters } from '../src/lib/candidateQuery.js';

const f = (over: Partial<CandidateFilters> = {}): CandidateFilters => ({ ...EMPTY_CANDIDATE_FILTERS, ...over });

test('candidateQuery: 0 is a filter, blank is not', () => {
  assert.equal(candidateQuery(f({ cpiMin: '0' })).get('cpiMin'), '0');
  assert.equal(candidateQuery(f({ cpiMin: '' })).has('cpiMin'), false);
  assert.equal(candidateQuery(f({ xMin: '  ' })).has('xMin'), false);
  const q = candidateQuery(f({ xMin: '80', xiiMin: '75.5', marksPctMin: '60' }));
  assert.deepEqual([q.get('xMin'), q.get('xiiMin'), q.get('marksPctMin')], ['80', '75.5', '60']);
});

test('candidateQuery: result NONE and sorts pass through, page params only when given', () => {
  const q = candidateQuery(f({ result: 'NONE', sort: 'marks', dir: 'desc', status: 'EVALUATED', flagged: 'true', search: 'ajith', jobRoleId: 'r1' }), 2, 50);
  assert.equal(q.get('result'), 'NONE');
  assert.equal(q.get('sort'), 'marks');
  assert.equal(q.get('dir'), 'desc');
  assert.equal(q.get('status'), 'EVALUATED');
  assert.equal(q.get('flagged'), 'true');
  assert.equal(q.get('search'), 'ajith');
  assert.equal(q.get('jobRoleId'), 'r1');
  assert.deepEqual([q.get('page'), q.get('pageSize')], ['2', '50']);
  const noPage = candidateQuery(f());
  assert.equal(noPage.has('page'), false);
  assert.equal(noPage.has('result'), false);
});

test('marksText formats and dashes', () => {
  assert.equal(marksText(null), '-');
  const exam = { startedAt: 'x', submittedAt: 'y', answeredCount: 2, questionCount: 2, maxMarks: 50 };
  assert.equal(marksText({ ...exam, totalMarks: null, percentage: null }), '-');
  assert.equal(marksText({ ...exam, totalMarks: 38, percentage: 76 }), '38 / 50 (76%)');
  assert.equal(marksText({ ...exam, totalMarks: 37.5, percentage: 75 }), '37.5 / 50 (75%)');
});

test('candidateQuery serialises driveId/collegeId/roundId/jobProfileType; blank ones are left out', () => {
  const q = candidateQuery(f({ driveId: 'd1', collegeId: 'c1', roundId: 'r1', jobProfileType: 'INTERNSHIP' }));
  assert.deepEqual([q.get('driveId'), q.get('collegeId'), q.get('roundId'), q.get('jobProfileType')], ['d1', 'c1', 'r1', 'INTERNSHIP']);
  const none = candidateQuery(f());
  for (const k of ['driveId', 'collegeId', 'roundId', 'jobProfileType']) assert.equal(none.has(k), false, k);
});

test('candidate query string carries batch and roundNumber', () => {
  const q = candidateQuery(f({ batch: 'Nov 2026', roundNumber: '1' }));
  assert.deepEqual([q.get('batch'), q.get('roundNumber')], ['Nov 2026', '1']);
  assert.equal(candidateQuery(f()).has('batch'), false);
});
