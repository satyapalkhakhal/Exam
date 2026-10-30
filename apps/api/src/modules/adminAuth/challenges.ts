// modules/adminAuth/challenges.ts
// The password->OTP hand-off: an opaque random challengeId, stored hashed in
// Redis for 5 min (the OTP's own lifetime) and mapped to the admin id, so the
// OTP step never takes an admin id from the client.

import crypto from 'node:crypto';
import { getRedis } from '../../infrastructure/redis/redis.js';
import { sha256 } from '../../shared/utils/hash.js';
import type { ChallengeStore } from './adminAuth.service.js';

const TTL_SECONDS = 300;
const key = (challengeId: string) => `exam:admin:challenge:${sha256(challengeId)}`;

export const redisChallengeStore: ChallengeStore = {
  async create(adminId) {
    const challengeId = crypto.randomBytes(32).toString('base64url');
    await getRedis().set(key(challengeId), adminId, 'EX', TTL_SECONDS);
    return challengeId;
  },
  async peek(challengeId) {
    return getRedis().get(key(challengeId));
  },
  async drop(challengeId) {
    await getRedis().del(key(challengeId));
  },
};
