// modules/adminAuth/passwordResets.ts
// One-time tokens for the admin "Forgot password?" link, in Redis (no table).
// Only sha256(token) is stored. Each admin has at most one live token (a new
// request kills the previous link) and may ask once per cooldown. A token is
// taken with GETDEL, so two concurrent resets with one link cannot both win.
// The record carries a fingerprint of the password hash at issue time; the
// service rejects the link if the password has changed since.

import crypto from 'node:crypto';
import { getRedis } from '../../infrastructure/redis/redis.js';
import { sha256 } from '../../shared/utils/hash.js';

export const RESET_TTL_SECONDS = 1800;
export const RESET_COOLDOWN_SECONDS = 60;

export interface ResetRecord {
  adminId: string;
  pw: string;
}

export interface ResetTokenStore {
  /** New raw token, or null when this admin asked inside the cooldown. Kills the admin's previous token. */
  issue(adminId: string, pw: string): Promise<string | null>;
  /** Atomically removes and returns the record; null if unknown, expired, used, or not the admin's newest. */
  take(token: string): Promise<ResetRecord | null>;
}

const tokenKey = (hash: string) => `exam:pwreset:${hash}`;
const adminKey = (adminId: string) => `exam:pwreset:admin:${adminId}`;
const cooldownKey = (adminId: string) => `exam:pwreset:cooldown:${adminId}`;

export const redisResetTokenStore: ResetTokenStore = {
  async issue(adminId, pw) {
    const redis = getRedis();
    const fresh = await redis.set(cooldownKey(adminId), '1', 'EX', RESET_COOLDOWN_SECONDS, 'NX');
    if (fresh !== 'OK') return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = sha256(token);
    const previous = await redis.get(adminKey(adminId));
    if (previous) await redis.del(tokenKey(previous));
    const record: ResetRecord = { adminId, pw };
    await redis.set(tokenKey(hash), JSON.stringify(record), 'EX', RESET_TTL_SECONDS);
    await redis.set(adminKey(adminId), hash, 'EX', RESET_TTL_SECONDS);
    return token;
  },

  async take(token) {
    const redis = getRedis();
    const hash = sha256(token);
    const raw = await redis.getdel(tokenKey(hash));
    if (!raw) return null;
    const record = JSON.parse(raw) as ResetRecord;
    if ((await redis.get(adminKey(record.adminId))) !== hash) return null;
    await redis.del(adminKey(record.adminId));
    return record;
  },
};
