// modules/messaging/messaging.config.ts
// Typed SMS/email config, defaults and the readiness check. Defaults fill any
// key a stored row lacks (e.g. the seeded blank otpTemplate).

import { getConfig } from '../systemConfig/index.js';

export interface SmsConfig {
  enabled: boolean;
  baseUrl: string;
  authToken: string;
  userName: string;
  apiKey: string;
  otpTemplate: string;
}

export interface EmailConfig {
  enabled: boolean;
  baseUrl: string;
  sendMailToken: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  /** Comma-separated; copied on the Shortlisted and Rejected emails. */
  ccAddresses: string;
}

export const SMS_KEY = 'sms.arihant';
export const EMAIL_KEY = 'email.zatpatmail';

export const SMS_DEFAULTS: SmsConfig = {
  enabled: false,
  baseUrl: 'https://arihantapi.arihantcapital.com/V1/api/Media/sendSMS',
  authToken: '',
  userName: '',
  apiKey: '',
  otpTemplate: 'Your Arihant Capital assessment OTP is {otp}. Valid for 5 minutes.',
};

export const EMAIL_DEFAULTS: EmailConfig = {
  enabled: false,
  baseUrl: 'https://api.zatpatmail.com',
  sendMailToken: '',
  fromAddress: '',
  fromName: 'Arihant Capital Recruitment',
  replyTo: '',
  ccAddresses: '',
};

// A blank stored value falls back to the default for fields that must never be
// empty; everything else is taken as stored.
const withDefaults = <T extends object>(defaults: T, raw: Partial<T>, nonBlank: (keyof T)[]): T => {
  const out = { ...defaults, ...raw } as T;
  for (const k of nonBlank) {
    const v = out[k];
    if (typeof v === 'string' && v.trim() === '') out[k] = defaults[k];
  }
  return out;
};

export const mergeSms = (raw: Partial<SmsConfig>): SmsConfig => withDefaults(SMS_DEFAULTS, raw, ['baseUrl', 'otpTemplate']);
export const mergeEmail = (raw: Partial<EmailConfig>): EmailConfig => withDefaults(EMAIL_DEFAULTS, raw, ['baseUrl']);

export const getSmsConfig = async (): Promise<SmsConfig> => mergeSms(await getConfig<Partial<SmsConfig>>(SMS_KEY));
export const getEmailConfig = async (): Promise<EmailConfig> => mergeEmail(await getConfig<Partial<EmailConfig>>(EMAIL_KEY));

const filled = (v: string): boolean => v.trim() !== '';

export function hasRequiredFields(cfg: SmsConfig | EmailConfig): boolean {
  if ('userName' in cfg) {
    return [cfg.baseUrl, cfg.authToken, cfg.userName, cfg.apiKey, cfg.otpTemplate].every(filled);
  }
  return [cfg.baseUrl, cfg.sendMailToken, cfg.fromAddress].every(filled);
}

/** Enabled AND every required field non-blank. */
export const isChannelReady = (cfg: SmsConfig | EmailConfig): boolean => cfg.enabled && hasRequiredFields(cfg);
