// The location review flags (design §7.2a) as a pure rule over already-fetched
// rows: login→start distance, candidates starting close together, shared IPs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLocationFlags, LOCATION_FLAG_THRESHOLDS } from '../src/modules/exam/locationFlags.js';

const GUWAHATI = { lat: 26.144, lng: 91.736 };
// ~60 km east of Guwahati along the same latitude.
const SIXTY_KM_EAST = { lat: 26.144, lng: 91.736 + 60 / (111.32 * Math.cos((26.144 * Math.PI) / 180)) };
// ~40 m north.
const FORTY_M_NORTH = { lat: 26.144 + 40 / 111_195, lng: 91.736 };

test('login 60 km from start → LOGIN_START_DISTANCE', () => {
  const flags = evaluateLocationFlags({ login: GUWAHATI, start: SIXTY_KM_EAST }, [], [], LOCATION_FLAG_THRESHOLDS);
  assert.equal(flags.length, 1);
  const f = flags[0];
  assert.ok(f && f.code === 'LOGIN_START_DISTANCE');
  assert.ok(f.km > 59 && f.km < 61, `km ${f.km}`);
});

test('login 10 km from start → no flag', () => {
  const tenKm = { lat: 26.144 + 10 / 111.195, lng: 91.736 };
  assert.deepEqual(evaluateLocationFlags({ login: GUWAHATI, start: tenKm }, [], [], LOCATION_FLAG_THRESHOLDS), []);
});

test('two starts 40 m apart → NEARBY_CANDIDATES', () => {
  const flags = evaluateLocationFlags(
    { login: null, start: GUWAHATI },
    [
      { candidateId: 'b', ...FORTY_M_NORTH },
      { candidateId: 'far', ...SIXTY_KM_EAST },
    ],
    [],
    LOCATION_FLAG_THRESHOLDS,
  );
  assert.equal(flags.length, 1);
  const f = flags[0];
  assert.ok(f && f.code === 'NEARBY_CANDIDATES');
  assert.deepEqual(f.withCandidateIds, ['b']);
  assert.ok(f.meters > 35 && f.meters < 45, `meters ${f.meters}`);
});

test('3 candidates on the same IP → SHARED_IP', () => {
  const flags = evaluateLocationFlags({ login: null, start: null }, [], [{ ip: '203.0.113.7', count: 3 }], LOCATION_FLAG_THRESHOLDS);
  assert.deepEqual(flags, [{ code: 'SHARED_IP', ip: '203.0.113.7', count: 3 }]);
});

test('2 candidates on the same IP → no flag', () => {
  assert.deepEqual(evaluateLocationFlags({ login: null, start: null }, [], [{ ip: '203.0.113.7', count: 2 }], LOCATION_FLAG_THRESHOLDS), []);
});

test('the thresholds are the plan values', () => {
  assert.deepEqual(LOCATION_FLAG_THRESHOLDS, { loginStartKm: 50, nearbyMeters: 100, sharedIpCandidates: 3 });
});
