import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { AdminForgotPasswordSchema, AdminResetPasswordSchema } from '@exam/shared';
import { getRedis, setRedisClient } from '../src/infrastructure/redis/redis.js';
import { sha256 } from '../src/shared/utils/hash.js';
import { RESET_TTL_SECONDS, redisResetTokenStore } from '../src/modules/adminAuth/passwordResets.js';

beforeEach(async () => {
  setRedisClient(new RedisMock() as unknown as Redis);
  await getRedis().flushall();
});

test('issue then take returns the record once', async () => {
  const t = await redisResetTokenStore.issue('a1', 'fp');
  assert.ok(t);
  assert.deepEqual(await redisResetTokenStore.take(t), { adminId: 'a1', pw: 'fp' });
  assert.equal(await redisResetTokenStore.take(t), null);
});

test('take is single-use under concurrency', async () => {
  const t = (await redisResetTokenStore.issue('a1', 'fp'))!;
  const r = await Promise.all([redisResetTokenStore.take(t), redisResetTokenStore.take(t)]);
  assert.equal(r.filter(Boolean).length, 1);
});

test('second issue inside the cooldown returns null', async () => {
  assert.ok(await redisResetTokenStore.issue('a1', 'fp'));
  assert.equal(await redisResetTokenStore.issue('a1', 'fp'), null);
});

test('cooldown is per admin', async () => {
  assert.ok(await redisResetTokenStore.issue('a1', 'fp'));
  assert.ok(await redisResetTokenStore.issue('a2', 'fp'));
});

test('newest link wins', async () => {
  const old = (await redisResetTokenStore.issue('a1', 'fp'))!;
  await getRedis().del('exam:pwreset:cooldown:a1');
  const fresh = (await redisResetTokenStore.issue('a1', 'fp'))!;
  assert.equal(await redisResetTokenStore.take(old), null);
  assert.deepEqual(await redisResetTokenStore.take(fresh), { adminId: 'a1', pw: 'fp' });
});

test('only the token hash is stored, with a 30-minute TTL', async () => {
  const t = (await redisResetTokenStore.issue('a1', 'fp'))!;
  assert.match(t, /^[\w-]{43}$/);
  const keys = await getRedis().keys('exam:pwreset:*');
  assert.ok(!keys.some((k) => k.includes(t)));
  const ttl = await getRedis().ttl(`exam:pwreset:${sha256(t)}`);
  assert.ok(ttl > 0 && ttl <= RESET_TTL_SECONDS);
  assert.equal(RESET_TTL_SECONDS, 1800);
});

test('unknown token → null', async () => {
  assert.equal(await redisResetTokenStore.take('x'.repeat(43)), null);
});

test('forgot-password schema trims and lower-cases the email', () => {
  assert.equal(AdminForgotPasswordSchema.parse({ email: ' Admin@Arihant.Test ' }).email, 'admin@arihant.test');
});

test('reset-password schema enforces the new-password rule', () => {
  assert.equal(AdminResetPasswordSchema.safeParse({ token: 't'.repeat(43), password: 'short' }).success, false);
  assert.equal(AdminResetPasswordSchema.safeParse({ token: 't'.repeat(43), password: 'long-enough-1' }).success, true);
  assert.equal(AdminResetPasswordSchema.safeParse({ token: '', password: 'long-enough-1' }).success, false);
});
