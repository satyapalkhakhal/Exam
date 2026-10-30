// infrastructure/crypto/secretBox.ts
// AES-256-GCM sealing for integration secrets at rest. Format
// `v1:<iv b64>:<tag b64>:<ciphertext b64>`; the key comes from
// CONFIG_ENCRYPTION_KEY (64 hex chars) and a fresh 12-byte IV is used per seal.

import crypto from 'node:crypto';
import { env } from '../config/env.js';

const VERSION = 'v1';
const key = (): Buffer => Buffer.from(env.CONFIG_ENCRYPTION_KEY, 'hex');

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`);
}

export function open(sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised sealed value');
  const [, iv, tag, ct] = parts as [string, string, string, string];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
