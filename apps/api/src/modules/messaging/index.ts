// modules/messaging/index.ts
export { sendSms } from './sms.client.js';
export { sendEmail } from './email.client.js';
export type { SendSmsParams } from './sms.client.js';
export type { SendEmailParams } from './email.client.js';
export { MessagingError } from './messaging.errors.js';
export { getSmsConfig, getEmailConfig, isChannelReady, SMS_KEY, EMAIL_KEY } from './messaging.config.js';
export type { SmsConfig, EmailConfig } from './messaging.config.js';
export { deliverOtp, buildOtpEmail, OTP_TTL_SECONDS } from './otpDelivery.service.js';
