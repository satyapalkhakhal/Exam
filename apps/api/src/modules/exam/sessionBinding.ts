// modules/exam/sessionBinding.ts
// Lets an unload save outlive the 15-minute access cookie. The browser drops an
// expired access cookie, so a pagehide beacon may arrive with only the refresh
// cookie, and a refresh token does not name its candidate to anyone but the
// refresh flow. So whenever a candidate opens their exam with a valid access
// token (start, resume, state read), the login family in that token is bound to
// the candidate here (`exam:exfam:{family}` -> {candidateId, at}). The beacon
// middleware accepts a live, un-rotated refresh token only for a bound family,
// and refuses it if the candidate's sessions were revoked after the binding.

import { getRedis } from '../../infrastructure/redis/redis.js';

const key = (family: string) => `exam:exfam:${family}`;
/** The candidate refresh-token lifetime plus one access lifetime. */
const TTL_SECONDS = 12 * 3_600 + 15 * 60;

export interface FamilyBinding {
  candidateId: string;
  /** When the binding was last written, ms. */
  at: number;
}

export async function bindExamFamily(family: string, candidateId: string): Promise<void> {
  const value: FamilyBinding = { candidateId, at: Date.now() };
  await getRedis().set(key(family), JSON.stringify(value), 'EX', TTL_SECONDS);
}

export async function resolveExamFamily(family: string): Promise<FamilyBinding | null> {
  const raw = await getRedis().get(key(family));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FamilyBinding>;
    return typeof v.candidateId === 'string' && typeof v.at === 'number' ? { candidateId: v.candidateId, at: v.at } : null;
  } catch {
    return null;
  }
}
