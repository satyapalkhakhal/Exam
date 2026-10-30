import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeCandidate, parsePurgeArgs, LOG_SCRUB } from '../src/scripts/purge-candidates.js';

const row = {
  id: '6b1f0c52-1111-4222-8333-944455556666',
  candidateCode: 'ARH-2026-0042',
  fullName: 'Asha Verma',
  email: 'asha@example.com',
  mobile: '9876543210',
  rollNumber: 'R-77',
  xPercentage: '88.50',
  xiiPercentage: '91.00',
  majorCpi: '8.40',
  discipline: 'Commerce',
  programme: 'B.Com',
  extra: { city: 'Pune', college: 'XYZ' },
  status: 'EVALUATED',
};

test('anonymizeCandidate strips personal fields and keeps the code and status', () => {
  const out = anonymizeCandidate(row);
  assert.equal(out.fullName, 'Anonymised');
  assert.equal(out.email, `anon+${row.id}@invalid`);
  assert.equal(out.mobile, null);
  assert.equal(out.rollNumber, null);
  assert.equal(out.xPercentage, null);
  assert.equal(out.xiiPercentage, null);
  assert.equal(out.majorCpi, null);
  assert.equal(out.discipline, null);
  assert.equal(out.programme, null);
  assert.deepEqual(out.extra, {});
  assert.equal(out.candidateCode, row.candidateCode);
  assert.equal(out.status, 'EVALUATED');
});

test('anonymizeCandidate does not mutate its input', () => {
  const copy = structuredClone(row);
  anonymizeCandidate(copy);
  assert.deepEqual(copy, row);
});

test('parsePurgeArgs requires --before and treats a missing --yes as a dry run', () => {
  assert.throws(() => parsePurgeArgs([]), /--before/);
  assert.throws(() => parsePurgeArgs(['--before', 'not-a-date']), /--before/);
  const dry = parsePurgeArgs(['--before', '2027-04-30']);
  assert.equal(dry.before.toISOString(), '2027-04-30T00:00:00.000Z');
  assert.equal(dry.apply, false);
  assert.equal(parsePurgeArgs(['--before', '2027-04-30', '--yes']).apply, true);
});

test('log scrub payloads clear IP and device data, using one IP placeholder for both tables', () => {
  assert.equal(LOG_SCRUB.activityLog.ip, LOG_SCRUB.loginLog.ip);
  assert.equal(LOG_SCRUB.activityLog.userAgent, null);
  assert.equal(LOG_SCRUB.loginLog.userAgent, '');
  assert.equal(LOG_SCRUB.loginLog.latitude, null);
  assert.equal(LOG_SCRUB.loginLog.longitude, null);
});
