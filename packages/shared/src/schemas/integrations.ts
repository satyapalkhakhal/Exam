// schemas/integrations.ts
// Zod contracts for Settings -> Integrations, shared by the API and the web
// form. A secret is write-only: input accepts it (omitted/null/blank = keep the
// stored one), output only ever says whether it is set plus its last 4 chars.

import { z } from 'zod';
import type { MaskedAiConfig } from './aiEvaluation.js';

const secretInput = z
  .string()
  .max(2000)
  .nullish()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : null));

const text = (max: number) => z.string().trim().max(max);

// A provider URL must be https and must not point at the machine itself or a
// private network, so a saved token can never be posted to an internal host.
export function isSafeProviderUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254));
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || host.startsWith('::ffff:')) return false;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  }
  return true;
}

const providerUrl = text(500).refine(isSafeProviderUrl, 'Base URL must be an https URL on a public host');

/** Most CC addresses the outcome emails may copy. */
export const MAX_EMAIL_CC = 10;

/** Splits a comma-separated address list (also accepts ; and new lines), trimmed, blanks and duplicates dropped. */
export function parseEmailList(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;\n]/)) {
    const a = raw.trim();
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      out.push(a);
    }
  }
  return out;
}

/** The first entry that is not a valid email, or null when every entry is fine. */
export function invalidEmailInList(value: string): string | null {
  return parseEmailList(value).find((a) => a.length > 320 || !z.string().email().safeParse(a).success) ?? null;
}

const emailList = text(4000)
  .refine((v) => invalidEmailInList(v) === null, (v) => ({ message: `Not a valid email: ${invalidEmailInList(v)}` }))
  .refine((v) => parseEmailList(v).length <= MAX_EMAIL_CC, `At most ${MAX_EMAIL_CC} addresses`)
  .transform((v) => parseEmailList(v).join(', '));

export const SmsConfigInputSchema = z.object({
  enabled: z.boolean(),
  baseUrl: providerUrl,
  authToken: secretInput,
  userName: text(200),
  apiKey: secretInput,
  otpTemplate: text(500).refine((v) => v === '' || v.includes('{otp}'), 'OTP template must contain {otp}'),
});

export const EmailConfigInputSchema = z.object({
  enabled: z.boolean(),
  baseUrl: providerUrl,
  sendMailToken: secretInput,
  fromAddress: text(320).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Invalid email'),
  fromName: text(200),
  replyTo: text(320).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Invalid email'),
  /** Copied on every Shortlisted and Rejected email, comma-separated. */
  ccAddresses: emailList.default(''),
});

export const SmsTestInputSchema = z.object({ mobile: z.string().trim().regex(/^\d{10}$/, 'Enter a 10-digit mobile number') });
export const EmailTestInputSchema = z.object({ email: z.string().trim().email().max(320) });

export type SmsConfigInput = z.input<typeof SmsConfigInputSchema>;
export type EmailConfigInput = z.input<typeof EmailConfigInputSchema>;

export interface MaskedSecret {
  set: boolean;
  last4: string | null;
}

export interface MaskedSmsConfig {
  enabled: boolean;
  baseUrl: string;
  authToken: MaskedSecret;
  userName: string;
  apiKey: MaskedSecret;
  otpTemplate: string;
}

export interface MaskedEmailConfig {
  enabled: boolean;
  baseUrl: string;
  sendMailToken: MaskedSecret;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  ccAddresses: string;
}

export interface IntegrationsView {
  sms: MaskedSmsConfig;
  email: MaskedEmailConfig;
  ai: MaskedAiConfig;
}
