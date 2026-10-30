// schemas/integrations.ts
// Zod contracts for Settings -> Integrations, shared by the API and the web
// form. A secret is write-only: input accepts it (omitted/null/blank = keep the
// stored one), output only ever says whether it is set plus its last 4 chars.

import { z } from 'zod';

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
}

export interface IntegrationsView {
  sms: MaskedSmsConfig;
  email: MaskedEmailConfig;
}
