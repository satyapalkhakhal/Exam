// modules/otp/otp.service.ts
// Issues and verifies 6-digit OTPs per design §7. The code is stored only as a
// sha256 hash in a Redis hash ({hash, attempts}, TTL 300 s) under an `exam:`
// prefix, and verified timing-safely. The attempt counter is bumped atomically
// (Lua) before the comparison and success is gated on winning the DEL, so
// parallel guesses can neither exceed the MAX_ATTEMPTS cap nor redeem a code twice. When no channel is enabled system-wide and
// ALLOW_STATIC_OTP is on, the hash of '123456' is stored exactly like a real
// code and nothing is sent, so verification is a single code path. Never logs
// the code.

import crypto from 'node:crypto';
import { env } from '../../infrastructure/config/env.js';
import { getRedis } from '../../infrastructure/redis/redis.js';
import { AppError } from '../../shared/errors.js';
import { safeEqual, sha256 } from '../../shared/utils/hash.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { getSmsConfig, getEmailConfig, isChannelReady, type SmsConfig, type EmailConfig } from '../messaging/index.js';
import { deliverOtp, OTP_TTL_SECONDS, type OtpChannel, type OtpPurpose, type OtpRecipient } from '../messaging/otpDelivery.service.js';

export type { OtpPurpose, OtpRecipient };

const COOLDOWN_SECONDS = 60;
/** Wrong tries allowed per code (admin and candidate); raised from 5 at the user's request 2026-11-01. */
export const MAX_ATTEMPTS = 25;
export const STATIC_OTP = '123456';

const otpKey = (purpose: OtpPurpose, subjectId: string) => `exam:otp:${purpose}:${subjectId}`;
const cooldownKey = (purpose: OtpPurpose, subjectId: string) => `exam:otp:cd:${purpose}:${subjectId}`;

export type OtpMode = 'static' | 'send' | 'unconfigured' | 'no_channel_for_recipient';

export function decideOtpMode(i: {
  smsReady: boolean;
  emailReady: boolean;
  allowStatic: boolean;
  recipient: OtpRecipient;
}): OtpMode {
  if (!i.smsReady && !i.emailReady) return i.allowStatic ? 'static' : 'unconfigured';
  const reachable = (i.smsReady && !!i.recipient.mobile) || (i.emailReady && !!i.recipient.email);
  return reachable ? 'send' : 'no_channel_for_recipient';
}

export interface OtpDeps {
  allowStatic: boolean;
  getConfigs: () => Promise<{ smsCfg: SmsConfig; emailCfg: EmailConfig }>;
  deliver: (code: string, recipient: OtpRecipient, purpose: OtpPurpose) => Promise<OtpChannel[]>;
}

const defaultDeps: OtpDeps = {
  allowStatic: env.ALLOW_STATIC_OTP,
  getConfigs: async () => ({ smsCfg: await getSmsConfig(), emailCfg: await getEmailConfig() }),
  deliver: (code, recipient, purpose) => deliverOtp(code, recipient, purpose),
};

const randomCode = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

export async function issueOtp(
  params: { purpose: OtpPurpose; subjectId: string; recipient: OtpRecipient },
  deps: OtpDeps = defaultDeps,
): Promise<{ deliveredVia: OtpChannel[]; static: boolean }> {
  const { purpose, subjectId, recipient } = params;
  const redis = getRedis();
  const cdKey = cooldownKey(purpose, subjectId);
  const key = otpKey(purpose, subjectId);

  const claimed = await redis.set(cdKey, '1', 'EX', COOLDOWN_SECONDS, 'NX');
  if (claimed !== 'OK') throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another code.');

  try {
    const { smsCfg, emailCfg } = await deps.getConfigs();
    const mode = decideOtpMode({
      smsReady: isChannelReady(smsCfg),
      emailReady: isChannelReady(emailCfg),
      allowStatic: deps.allowStatic,
      recipient,
    });
    if (mode === 'unconfigured') throw new AppError(503, 'OTP_DELIVERY_UNCONFIGURED', 'OTP delivery is not configured.');
    if (mode === 'no_channel_for_recipient') {
      throw new AppError(502, 'OTP_DELIVERY_FAILED', "We couldn't send your code. Please contact HR.");
    }

    const isStatic = mode === 'static';
    const code = isStatic ? STATIC_OTP : randomCode();
    await redis.multi().del(key).hset(key, { hash: sha256(code), attempts: 0 }).expire(key, OTP_TTL_SECONDS).exec();
    if (isStatic) return { deliveredVia: [], static: true };

    const deliveredVia = await deps.deliver(code, recipient, purpose);
    logger.info('OTP issued', { purpose, channels: deliveredVia });
    return { deliveredVia, static: false };
  } catch (err) {
    await redis.del(key, cdKey);
    throw err;
  }
}

// Atomically: missing key -> nil; otherwise count this try and return
// {hash, attempts-after-increment}. EXISTS first so a key deleted by a racing
// caller is never resurrected (without a TTL) by HINCRBY.
const TAKE_ATTEMPT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
return {redis.call('HGET', KEYS[1], 'hash'), n}
`;

export async function verifyOtp(params: { purpose: OtpPurpose; subjectId: string; code: string }): Promise<void> {
  const redis = getRedis();
  const key = otpKey(params.purpose, params.subjectId);
  const expired = () => new AppError(400, 'OTP_EXPIRED', 'This code has expired. Please request a new one.');

  const taken = (await redis.eval(TAKE_ATTEMPT_LUA, 1, key)) as [string | null, number] | null;
  if (!taken || !taken[0]) throw expired();
  const [hash, attempts] = taken;

  if (attempts > MAX_ATTEMPTS) {
    await redis.del(key);
    throw new AppError(429, 'OTP_LOCKED', 'Too many incorrect attempts. Please request a new code.');
  }
  if (!safeEqual(sha256(params.code), hash)) throw new AppError(400, 'OTP_INVALID', 'Incorrect code.');
  // Only the caller that actually removes the key wins; a parallel duplicate loses.
  if ((await redis.del(key)) !== 1) throw expired();
}
