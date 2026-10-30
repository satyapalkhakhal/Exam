// infrastructure/redis/redis.ts
// Lazily-connected shared ioredis client. keyPrefix is deliberately NOT set:
// callers prefix keys with `exam:` themselves, so BullMQ (which manages its own
// prefix) is unaffected and this Redis can be shared with another app locally.
// setRedisClient lets tests inject ioredis-mock.

import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let client: Redis | undefined;

export function getRedis(): Redis {
  client ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return client;
}

export function setRedisClient(next: Redis | undefined): void {
  client = next;
}
