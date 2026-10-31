import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { setRedisClient, getRedis } from '../src/infrastructure/redis/redis.js';
import { issueOtp, MAX_ATTEMPTS, verifyOtp, type OtpDeps } from '../src/modules/otp/otp.service.js';
import { sha256, safeEqual } from '../src/shared/utils/hash.js';

const recipient = { email: 'a@b.com', mobile: null };
const staticDeps: OtpDeps = {
  allowStatic: true,
  getConfigs: async () => ({
    smsCfg: { enabled: false, baseUrl: 'x', authToken: '', userName: '', apiKey: '', otpTemplate: 't {otp}' },
    emailCfg: { enabled: false, baseUrl: 'x', sendMailToken: '', fromAddress: '', fromName: '', replyTo: '' },
  }),
  deliver: async () => { throw new Error('must not send in static mode'); },
};
const P = { purpose: 'candidate_login' as const, subjectId: 'c1' };

beforeEach(async () => {
  setRedisClient(new RedisMock() as unknown as Redis);
  await getRedis().flushall();
});

test('hash helpers', () => {
  assert.equal(sha256('123456').length, 64);
  assert.ok(safeEqual(sha256('a'), sha256('a')));
  assert.ok(!safeEqual('a', 'bb'));
});

test('static mode accepts 123456 and stores only the hash under exam: prefix', async () => {
  const r = await issueOtp({ ...P, recipient }, staticDeps);
  assert.deepEqual(r, { deliveredVia: [], static: true });
  const raw = JSON.stringify(await getRedis().hgetall('exam:otp:candidate_login:c1'));
  assert.ok(raw.includes('"hash"') && !raw.includes('123456'));
  assert.equal(await getRedis().ttl('exam:otp:candidate_login:c1') > 0, true);
  await verifyOtp({ ...P, code: '123456' });
});

test('second issue within cooldown -> OTP_COOLDOWN', async () => {
  await issueOtp({ ...P, recipient }, staticDeps);
  await assert.rejects(issueOtp({ ...P, recipient }, staticDeps), (e: { code?: string }) => e.code === 'OTP_COOLDOWN');
});

test('MAX_ATTEMPTS (25) wrong then right -> OTP_LOCKED', async () => {
  assert.equal(MAX_ATTEMPTS, 25);
  await issueOtp({ ...P, recipient }, staticDeps);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await assert.rejects(verifyOtp({ ...P, code: '000000' }), (e: { code?: string }) => e.code === 'OTP_INVALID');
  }
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e: { code?: string }) => e.code === 'OTP_LOCKED');
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e: { code?: string }) => e.code === 'OTP_EXPIRED');
});

test('expired key -> OTP_EXPIRED', async () => {
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e: { code?: string }) => e.code === 'OTP_EXPIRED');
});

test('success consumes the code', async () => {
  await issueOtp({ ...P, recipient }, staticDeps);
  await verifyOtp({ ...P, code: '123456' });
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e: { code?: string }) => e.code === 'OTP_EXPIRED');
});

test('unconfigured and no-channel modes throw delivery errors, leaving no key', async () => {
  await assert.rejects(issueOtp({ ...P, recipient }, { ...staticDeps, allowStatic: false }), (e: { code?: string }) => e.code === 'OTP_DELIVERY_UNCONFIGURED');
  assert.equal(await getRedis().exists('exam:otp:candidate_login:c1'), 0);
  assert.equal(await getRedis().get('exam:otp:cd:candidate_login:c1'), null);
});

test('send mode stores a random hashed code and passes it to deliver', async () => {
  let sentCode = '';
  const deps: OtpDeps = {
    allowStatic: true,
    getConfigs: async () => ({ ...(await staticDeps.getConfigs()), emailCfg: { enabled: true, baseUrl: 'x', sendMailToken: 't', fromAddress: 'a@b.c', fromName: '', replyTo: '' } }),
    deliver: async (code) => { sentCode = code; return ['email']; },
  };
  const r = await issueOtp({ ...P, recipient }, deps);
  assert.deepEqual(r, { deliveredVia: ['email'], static: false });
  assert.match(sentCode, /^\d{6}$/);
  const raw = JSON.stringify(await getRedis().hgetall('exam:otp:candidate_login:c1'));
  assert.ok(raw.includes('"hash"') && !raw.includes(sentCode));
  await verifyOtp({ ...P, code: sentCode });
});

const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

test('2×MAX_ATTEMPTS parallel wrong verifies count at most MAX_ATTEMPTS tries and leave the code unusable', async () => {
  await issueOtp({ ...P, recipient }, staticDeps);
  const results = await Promise.allSettled(Array.from({ length: 2 * MAX_ATTEMPTS }, () => verifyOtp({ ...P, code: '000000' })));
  const codes = results.map((r) => (r.status === 'rejected' ? codeOf(r.reason) : 'OK'));
  assert.ok(!codes.includes('OK'));
  assert.ok(codes.filter((c) => c === 'OTP_INVALID').length <= MAX_ATTEMPTS, `counted tries: ${codes.join(',')}`);
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e) => ['OTP_LOCKED', 'OTP_EXPIRED'].includes(codeOf(e) ?? ''));
});

test('two parallel correct verifies give exactly one success', async () => {
  await issueOtp({ ...P, recipient }, staticDeps);
  const results = await Promise.allSettled([verifyOtp({ ...P, code: '123456' }), verifyOtp({ ...P, code: '123456' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.equal(failed && failed.status === 'rejected' ? codeOf(failed.reason) : undefined, 'OTP_EXPIRED');
});
