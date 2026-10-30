// shared/utils/hash.ts
// sha256 hex digest and a timing-safe comparison, used for OTPs and tokens that
// are stored hashed and must not leak through comparison timing.

import crypto from 'node:crypto';

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
