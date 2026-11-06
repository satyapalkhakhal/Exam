// modules/systemConfig/systemConfig.service.ts
// Key/value config with encrypted secret fields. Secrets are sealed on write and
// opened on read; a blank or never-sealed value (the seed writes plain '') reads
// back as '' ("not set") instead of throwing. Reads are cached for 60 s and every
// write drops the cache.

import { isSealed, open, seal } from '../../infrastructure/crypto/secretBox.js';

export const SECRET_FIELDS: Record<string, readonly string[]> = {
  'sms.arihant': ['authToken', 'apiKey'],
  'email.zatpatmail': ['sendMailToken'],
  'ai.openai': ['apiKey'],
};

const CACHE_TTL_MS = 60_000;

export interface SystemConfigRepository {
  findByKey(key: string): Promise<{ key: string; value: unknown } | null>;
  /** adminId is null only for the break-glass CLI, which has no signed-in admin. */
  upsert(key: string, value: unknown, adminId: string | null): Promise<void>;
}

export function createSystemConfigService(repo: SystemConfigRepository) {
  const cache = new Map<string, { at: number; value: Record<string, unknown> }>();

  async function getConfig<T>(key: string): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value } as T;
    const row = await repo.findByKey(key);
    const value: Record<string, unknown> = { ...((row?.value as Record<string, unknown> | undefined) ?? {}) };
    for (const field of SECRET_FIELDS[key] ?? []) {
      const stored = value[field];
      value[field] = isSealed(stored) ? open(stored) : '';
    }
    cache.set(key, { at: Date.now(), value });
    return { ...value } as T;
  }

  async function setConfig(key: string, value: Record<string, unknown>, adminId: string): Promise<void> {
    const toStore: Record<string, unknown> = { ...value };
    for (const field of SECRET_FIELDS[key] ?? []) {
      const plain = toStore[field];
      toStore[field] = typeof plain === 'string' && plain !== '' ? seal(plain) : '';
    }
    await repo.upsert(key, toStore, adminId);
    cache.delete(key);
  }

  return { getConfig, setConfig };
}

export type SystemConfigService = ReturnType<typeof createSystemConfigService>;
