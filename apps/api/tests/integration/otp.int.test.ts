// The OTP attempt counter and single-use guarantee under real concurrency,
// against Redis db 15 (ioredis-mock cannot interleave like a real server).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../../src/infrastructure/config/env.js';
import { getRedis } from '../../src/infrastructure/redis/redis.js';
import { issueOtp, verifyOtp, type OtpDeps } from '../../src/modules/otp/index.js';
import { MAX_ATTEMPTS } from '../../src/modules/otp/otp.service.js';

const deps: OtpDeps = {
  allowStatic: true,
  getConfigs: async () => ({
    smsCfg: { enabled: false, baseUrl: 'x', authToken: '', userName: '', apiKey: '', otpTemplate: '{otp}' },
    emailCfg: { enabled: false, baseUrl: 'x', sendMailToken: '', fromAddress: '', fromName: '', replyTo: '' },
  }),
  deliver: async () => [],
};
const codeOf = (e: unknown) => (e as { code?: string }).code;

before(async () => {
  assert.match(env.REDIS_URL, /\/15$/);
  await getRedis().flushdb();
});
after(async () => {
  await getRedis().quit();
});

test('50 parallel wrong verifies: exactly MAX_ATTEMPTS (25) counted as tries, then the code is dead', async () => {
  const P = { purpose: 'candidate_login' as const, subjectId: 'int-par-wrong' };
  await issueOtp({ ...P, recipient: { email: 'a@b.c', mobile: null } }, deps);
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => verifyOtp({ ...P, code: '000000' })));
  const codes = results.map((r) => (r.status === 'rejected' ? codeOf(r.reason) : 'OK'));
  assert.equal(codes.filter((c) => c === 'OTP_INVALID').length, MAX_ATTEMPTS);
  assert.ok(codes.every((c) => c === 'OTP_INVALID' || c === 'OTP_LOCKED' || c === 'OTP_EXPIRED'));
  await assert.rejects(verifyOtp({ ...P, code: '123456' }), (e) => codeOf(e) === 'OTP_EXPIRED');
  assert.equal(await getRedis().exists('exam:otp:candidate_login:int-par-wrong'), 0);
});

test('5 parallel correct verifies (within the try cap): exactly one succeeds, the rest OTP_EXPIRED', async () => {
  const P = { purpose: 'candidate_login' as const, subjectId: 'int-par-right' };
  await issueOtp({ ...P, recipient: { email: 'a@b.c', mobile: null } }, deps);
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => verifyOtp({ ...P, code: '123456' })));
  const codes = results.map((r) => (r.status === 'fulfilled' ? 'OK' : codeOf(r.reason)));
  assert.equal(codes.filter((c) => c === 'OK').length, 1, codes.join(','));
  assert.equal(codes.filter((c) => c === 'OTP_EXPIRED').length, 4, codes.join(','));
});

// Every try (right or wrong) counts against the 5-try cap, so a flood beyond
// it is refused with OTP_LOCKED; it may fail closed, but never yields two wins.
test('20 parallel correct verifies: never more than one success', async () => {
  const P = { purpose: 'candidate_login' as const, subjectId: 'int-par-flood' };
  await issueOtp({ ...P, recipient: { email: 'a@b.c', mobile: null } }, deps);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => verifyOtp({ ...P, code: '123456' })));
  const codes = results.map((r) => (r.status === 'fulfilled' ? 'OK' : codeOf(r.reason)));
  assert.ok(codes.filter((c) => c === 'OK').length <= 1, codes.join(','));
  assert.ok(codes.every((c) => c === 'OK' || c === 'OTP_EXPIRED' || c === 'OTP_LOCKED'), codes.join(','));
});
