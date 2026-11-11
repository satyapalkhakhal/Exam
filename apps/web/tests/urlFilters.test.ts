import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_FILTER_VALIDATORS, filtersFromSearch, linkedFilterLabel } from '../src/lib/urlFilters.js';

const EMPTY = { collegeId: '', batch: '', jobRoleId: '', jobProfileType: '', roundNumber: '', search: '' };
const ID = '0b6d3f1e-6d0c-4f3a-9a52-7f2f6f0f1a11';

test('url filters fill known keys and ignore unknown or invalid ones', () => {
  const got = filtersFromSearch(`?collegeId=${ID}&batch=Nov+2026&jobProfileType=PLACEMENT&roundNumber=1&evil=1&search=x`, EMPTY, LINK_FILTER_VALIDATORS);
  assert.deepEqual(got, { ...EMPTY, collegeId: ID, batch: 'Nov 2026', jobProfileType: 'PLACEMENT', roundNumber: '1' }, 'search has no validator, so a link cannot set it');
  const bad = filtersFromSearch('?collegeId=not-a-uuid&jobProfileType=FOO&roundNumber=0&batch=' + 'x'.repeat(61), EMPTY, LINK_FILTER_VALIDATORS);
  assert.deepEqual(bad, EMPTY);
  assert.deepEqual(filtersFromSearch('?roundNumber=21', EMPTY, LINK_FILTER_VALIDATORS).roundNumber, '');
  assert.deepEqual(filtersFromSearch('', EMPTY, LINK_FILTER_VALIDATORS), EMPTY);
  // A caller can narrow the validators (an Evaluator never takes college or batch from a link).
  const { collegeId: _c, batch: _b, ...blind } = LINK_FILTER_VALIDATORS;
  assert.deepEqual(filtersFromSearch(`?collegeId=${ID}&batch=Nov+2026&roundNumber=2`, EMPTY, blind), { ...EMPTY, roundNumber: '2' });
});

test('linked filter label names college, batch, round and programme', () => {
  assert.equal(linkedFilterLabel({ collegeName: 'IITG', batch: 'Nov 2026', roundNumber: '1', jobProfileType: 'INTERNSHIP' }), 'IITG · Nov 2026 · Round 1 · Internship');
  assert.equal(linkedFilterLabel({ batch: 'Nov 2026' }), 'Nov 2026');
  assert.equal(linkedFilterLabel({}), '');
});
