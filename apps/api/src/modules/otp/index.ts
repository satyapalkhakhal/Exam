// modules/otp/index.ts
export { issueOtp, verifyOtp, decideOtpMode, STATIC_OTP } from './otp.service.js';
export type { OtpPurpose, OtpRecipient, OtpDeps, OtpMode } from './otp.service.js';
