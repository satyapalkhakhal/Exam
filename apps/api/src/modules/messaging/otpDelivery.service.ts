// modules/messaging/otpDelivery.service.ts
// The one place an OTP leaves the building. Sends on every READY channel (enabled
// and fully configured) the recipient has, in parallel, and succeeds when EITHER
// delivers: email is the backup for an SMS that never arrives. Email copy is
// adapted from the CRM's buildOtpEmail; the code is in the body only, never the
// subject. Never logs the code; recipients are masked.

import { AppError } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { maskEmail, maskMobile } from '../../shared/utils/piiMask.js';
import { sendSms } from './sms.client.js';
import { sendEmail } from './email.client.js';
import { getSmsConfig, getEmailConfig, isChannelReady, type SmsConfig, type EmailConfig } from './messaging.config.js';

export type OtpPurpose = 'admin_login' | 'candidate_login';
export interface OtpRecipient {
  email: string;
  mobile: string | null;
}
export type OtpChannel = 'sms' | 'email';

export interface OtpDeliveryDeps {
  smsCfg?: SmsConfig;
  emailCfg?: EmailConfig;
  sendSms?: (p: { to: string; message: string }) => Promise<void>;
  sendEmail?: (p: { to: string; subject: string; html: string; text: string }) => Promise<void>;
}

export const OTP_TTL_SECONDS = 300;

const EMAIL_COPY: Record<OtpPurpose, { subject: string; action: string }> = {
  candidate_login: {
    subject: 'Your sign-in code for the Arihant Capital Recruitment Assessment',
    action: 'sign in to the Arihant Capital Recruitment Assessment',
  },
  admin_login: {
    subject: 'Your sign-in code for the Arihant Capital Recruitment Assessment admin console',
    action: 'sign in to the Arihant Capital Recruitment Assessment admin console',
  },
};

export function buildOtpEmail(otp: string, purpose: OtpPurpose): { subject: string; html: string; text: string } {
  const { subject, action } = EMAIL_COPY[purpose];
  const minutes = Math.ceil(OTP_TTL_SECONDS / 60);
  const validity = `valid for ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const warning = 'If you did not request this code, please contact it.support@arihantcapital.com immediately.';
  return {
    subject,
    text: `Your one-time code to ${action} is ${otp}.\nThis code is ${validity}.\n${warning}`,
    html:
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">' +
      `<p>Your one-time code to ${action} is:</p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${otp}</p>` +
      `<p>This code is ${validity}.</p>` +
      `<p>${warning}</p></div>`,
  };
}

export async function deliverOtp(
  code: string,
  recipient: OtpRecipient,
  purpose: OtpPurpose,
  deps: OtpDeliveryDeps = {},
): Promise<OtpChannel[]> {
  const smsCfg = deps.smsCfg ?? (await getSmsConfig());
  const emailCfg = deps.emailCfg ?? (await getEmailConfig());
  const doSms = deps.sendSms ?? ((p) => sendSms(p, smsCfg));
  const doEmail = deps.sendEmail ?? ((p) => sendEmail(p, emailCfg));

  const jobs: Promise<OtpChannel | null>[] = [];
  if (recipient.mobile && isChannelReady(smsCfg)) {
    const to = `91${recipient.mobile}`;
    jobs.push(
      doSms({ to, message: smsCfg.otpTemplate.replaceAll('{otp}', code) }).then(
        () => 'sms' as const,
        (err: unknown) => {
          logger.warn('OTP SMS delivery failed', { purpose, to: maskMobile(to), error: err instanceof Error ? err.message : 'unknown' });
          return null;
        },
      ),
    );
  }
  if (recipient.email && isChannelReady(emailCfg)) {
    jobs.push(
      doEmail({ to: recipient.email, ...buildOtpEmail(code, purpose) }).then(
        () => 'email' as const,
        (err: unknown) => {
          logger.warn('OTP email delivery failed', { purpose, to: maskEmail(recipient.email), error: err instanceof Error ? err.message : 'unknown' });
          return null;
        },
      ),
    );
  }

  const delivered = (await Promise.all(jobs)).filter((c): c is OtpChannel => c !== null);
  if (delivered.length === 0) throw new AppError(502, 'OTP_DELIVERY_FAILED', "We couldn't send your code. Please contact HR.");
  return delivered;
}
