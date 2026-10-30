import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '../src/shared/utils/geo.js';

test('the same point is 0 m apart', () => {
  const p = { lat: 26.1445, lng: 91.7362 };
  assert.equal(haversineMeters(p, p), 0);
});

test('Guwahati to Delhi is about 1,459 km', () => {
  const km = haversineMeters({ lat: 26.1445, lng: 91.7362 }, { lat: 28.6139, lng: 77.209 }) / 1000;
  assert.ok(Math.abs(km - 1459) <= 5, `got ${km}`);
});

test('distance is symmetric', () => {
  const a = { lat: 12.97, lng: 77.59 };
  const b = { lat: 19.07, lng: 72.87 };
  assert.equal(haversineMeters(a, b), haversineMeters(b, a));
});
