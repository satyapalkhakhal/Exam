import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateExamDto } from '@exam/shared';
import { examPaths, groupExams } from '../src/lib/examSections.js';

const mk = (id: string, over: Partial<CandidateExamDto> = {}): CandidateExamDto => ({
  applicationId: id,
  candidateCode: `C-${id}`,
  jobRole: { id: `r-${id}`, name: `Role ${id}` },
  jobProfileType: 'PLACEMENT',
  roundNumber: null,
  mcqNegativeMarks: 0,
  progress: 'NOT_STARTED',
  selectedForNextRound: 'AWAITED',
  nearbyCount: null,
  locationExempt: false,
  durationMinutes: 60,
  windowStart: null,
  windowEnd: null,
  isOpen: true,
  instructions: '',
  attempt: null,
  ...over,
});
const NOW = Date.parse('2026-11-03T10:00:00Z');
const ids = (xs: CandidateExamDto[]) => xs.map((x) => x.applicationId);

test('groups every exam into exactly one section', () => {
  const s = groupExams(
    [
      mk('a', { progress: 'IN_PROGRESS' }),
      mk('b'),
      mk('c', { windowStart: '2026-11-04T00:00:00Z' }),
      mk('d', { windowEnd: '2026-11-02T00:00:00Z' }),
      mk('e', { isOpen: false }),
      mk('f', { progress: 'SUBMITTED', isOpen: false }),
    ],
    NOW,
  );
  assert.deepEqual(ids(s.inProgress), ['a']);
  assert.deepEqual(ids(s.available), ['b']);
  assert.deepEqual(ids(s.upcoming), ['c']);
  assert.deepEqual(ids(s.closed), ['d', 'e']);
  assert.deepEqual(ids(s.completed), ['f']);
});

test('an in-progress exam stays in progress after its window closed', () => {
  const s = groupExams([mk('a', { progress: 'IN_PROGRESS', windowEnd: '2026-11-01T00:00:00Z' })], NOW);
  assert.equal(s.inProgress.length, 1);
  assert.equal(s.closed.length, 0);
});

test('the clock decides: the same exam moves from upcoming to available', () => {
  const e = mk('a', { windowStart: '2026-11-03T10:30:00Z' });
  assert.equal(groupExams([e], NOW).upcoming.length, 1);
  assert.equal(groupExams([e], NOW + 31 * 60_000).available.length, 1);
});

test('empty list gives empty sections; paths', () => {
  const s = groupExams([], NOW);
  assert.deepEqual(Object.values(s).map((v) => v.length), [0, 0, 0, 0, 0]);
  assert.equal(examPaths.take('x'), '/exams/x/take');
  assert.equal(examPaths.submitted('x'), '/exams/x/submitted');
});
