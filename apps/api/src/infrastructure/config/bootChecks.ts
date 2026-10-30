// infrastructure/config/bootChecks.ts
// What the API says about OTP delivery when it starts. The static OTP is
// deliberately allowed until real SMS/email credentials are entered, so
// production boots with it on rather than refusing; instead it logs a loud
// banner so nobody runs the live exam with 123456 still accepted. Pure, so
// the rules are unit tested; index.ts supplies the channel state and logs.

export interface OtpPostureInput {
  nodeEnv: 'development' | 'production' | 'test';
  allowStatic: boolean;
  /** Channel enabled and its credentials present (messaging isChannelReady). */
  smsReady: boolean;
  emailReady: boolean;
}

export interface BootLogLine {
  level: 'warn' | 'info';
  message: string;
  meta?: Record<string, unknown>;
}

export const STATIC_OTP_BANNER = 'STATIC OTP 123456 ENABLED — set ALLOW_STATIC_OTP=false before the live exam';

export function otpPosture(i: OtpPostureInput): BootLogLine[] {
  const lines: BootLogLine[] = [
    {
      level: 'info',
      message: 'OTP delivery channels',
      meta: { smsEnabled: i.smsReady, emailEnabled: i.emailReady, staticOtpAllowed: i.allowStatic },
    },
  ];
  if (i.allowStatic && i.nodeEnv === 'production') lines.unshift({ level: 'warn', message: STATIC_OTP_BANNER });
  return lines;
}
