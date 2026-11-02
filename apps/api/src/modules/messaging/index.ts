// modules/messaging/index.ts
export { sendSms } from './sms.client.js';
export { sendEmail } from './email.client.js';
export type { SendSmsParams } from './sms.client.js';
export type { SendEmailParams } from './email.client.js';
export { MessagingError } from './messaging.errors.js';
export { getSmsConfig, getEmailConfig, isChannelReady, SMS_KEY, EMAIL_KEY } from './messaging.config.js';
export type { SmsConfig, EmailConfig } from './messaging.config.js';
export { deliverOtp, buildOtpEmail, OTP_TTL_SECONDS } from './otpDelivery.service.js';
export { buildSubmissionEmail, buildShortlistEmail, DEFAULT_HR_CONTACT, DEFAULT_EMAIL_TEMPLATES, unknownPlaceholders, fillPlaceholders } from './candidateEmails.js';
export type { EmailContent, EmailTemplate, SubmissionEmailParams, ShortlistEmailParams, NextRoundDetails } from './candidateEmails.js';
