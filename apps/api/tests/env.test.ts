import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/infrastructure/config/env.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/exam_db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ADMIN_SECRET: 'a'.repeat(32),
  JWT_CANDIDATE_SECRET: 'b'.repeat(32),
  CONFIG_ENCRYPTION_KEY: 'c'.repeat(64),
  PUBLIC_WEB_URL: 'http://localhost:5174',
  CORS_ORIGIN: 'http://localhost:5174',
};

test('throws when candidate secret equals admin secret', () => {
  assert.throws(() => loadEnv({ ...base, JWT_CANDIDATE_SECRET: base.JWT_ADMIN_SECRET }));
});

test('throws when CONFIG_ENCRYPTION_KEY is not 64 hex chars', () => {
  assert.throws(() => loadEnv({ ...base, CONFIG_ENCRYPTION_KEY: 'c'.repeat(63) }));
  assert.throws(() => loadEnv({ ...base, CONFIG_ENCRYPTION_KEY: 'z'.repeat(64) }));
});

test("ALLOW_STATIC_OTP 'false' parses to false, 'true' to true", () => {
  assert.equal(loadEnv({ ...base, ALLOW_STATIC_OTP: 'false' }).ALLOW_STATIC_OTP, false);
  assert.equal(loadEnv({ ...base, ALLOW_STATIC_OTP: 'true' }).ALLOW_STATIC_OTP, true);
});

test('ALLOW_STATIC_OTP defaults to false when unset (fails closed)', () => {
  const { ALLOW_STATIC_OTP: _unset, ...rest } = base as Record<string, string>;
  assert.equal(loadEnv(rest).ALLOW_STATIC_OTP, false);
});

test('PORT defaults to 4100 and other defaults hold', () => {
  const e = loadEnv(base);
  assert.equal(e.PORT, 4100);
  assert.equal(e.TRUST_PROXY, 0);
  assert.equal(e.COOKIE_SECURE, false);
});
