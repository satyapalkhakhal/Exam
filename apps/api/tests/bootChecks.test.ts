import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otpPosture } from '../src/infrastructure/config/bootChecks.js';

const BANNER = 'STATIC OTP 123456 ENABLED — set ALLOW_STATIC_OTP=false before the live exam';

test('production + static OTP on -> warn banner, and channel status is reported', () => {
  const lines = otpPosture({ nodeEnv: 'production', allowStatic: true, smsReady: false, emailReady: false });
  assert.deepEqual(lines.find((l) => l.level === 'warn'), { level: 'warn', message: BANNER });
  const info = lines.find((l) => l.level === 'info');
  assert.equal(info?.message, 'OTP delivery channels');
  assert.deepEqual(info?.meta, { smsEnabled: false, emailEnabled: false, staticOtpAllowed: true });
});

test('no banner outside production, nor in production with static off', () => {
  for (const c of [
    { nodeEnv: 'development' as const, allowStatic: true },
    { nodeEnv: 'production' as const, allowStatic: false },
  ]) {
    const lines = otpPosture({ ...c, smsReady: true, emailReady: false });
    assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
    assert.deepEqual(lines.find((l) => l.level === 'info')?.meta, { smsEnabled: true, emailEnabled: false, staticOtpAllowed: c.allowStatic });
  }
});
