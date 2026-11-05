import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverOtp } from '../src/modules/messaging/otpDelivery.service.js';
import { decideOtpMode } from '../src/modules/otp/otp.service.js';
import type { SmsConfig, EmailConfig } from '../src/modules/messaging/messaging.config.js';

const smsCfg: SmsConfig = { enabled: true, baseUrl: 'https://g.test/s', authToken: 'a', userName: 'u', apiKey: 'k', otpTemplate: 'Code {otp} ok' };
const emailCfg: EmailConfig = { enabled: true, baseUrl: 'https://m.test', sendMailToken: 't', fromAddress: 'a@b.c', fromName: 'A', replyTo: '', ccAddresses: '' };
const recipient = { email: 'x@y.com', mobile: '9876543210' };

test('decideOtpMode table', () => {
  const r = { email: 'a@b.c', mobile: null };
  assert.equal(decideOtpMode({ smsReady: false, emailReady: false, allowStatic: true, recipient: r }), 'static');
  assert.equal(decideOtpMode({ smsReady: false, emailReady: false, allowStatic: false, recipient: r }), 'unconfigured');
  assert.equal(decideOtpMode({ smsReady: true, emailReady: false, allowStatic: true, recipient: { email: 'a@b.c', mobile: null } }), 'no_channel_for_recipient');
  assert.equal(decideOtpMode({ smsReady: false, emailReady: true, allowStatic: true, recipient: r }), 'send');
});

test('sms rejects, email resolves -> [email]', async () => {
  const via = await deliverOtp('654321', recipient, 'candidate_login', {
    smsCfg, emailCfg,
    sendSms: async () => { throw new Error('down'); },
    sendEmail: async () => undefined,
  });
  assert.deepEqual(via, ['email']);
});

test('both reject -> OTP_DELIVERY_FAILED', async () => {
  await assert.rejects(
    deliverOtp('654321', recipient, 'admin_login', {
      smsCfg, emailCfg,
      sendSms: async () => { throw new Error('x'); },
      sendEmail: async () => { throw new Error('y'); },
    }),
    (e: { code?: string }) => e.code === 'OTP_DELIVERY_FAILED',
  );
});

test('only ready channels are used; sms text and 91 prefix', async () => {
  const sent: { to: string; message: string }[] = [];
  let emailCalls = 0;
  const via = await deliverOtp('111222', recipient, 'candidate_login', {
    smsCfg, emailCfg: { ...emailCfg, enabled: false },
    sendSms: async (p) => { sent.push(p); },
    sendEmail: async () => { emailCalls++; },
  });
  assert.deepEqual(via, ['sms']);
  assert.equal(emailCalls, 0);
  assert.deepEqual(sent, [{ to: '919876543210', message: 'Code 111222 ok' }]);
});

test('email carries code in body only', async () => {
  let captured: { subject: string; html: string; text: string } | undefined;
  await deliverOtp('777888', { email: 'x@y.com', mobile: null }, 'admin_login', {
    smsCfg: { ...smsCfg, enabled: false }, emailCfg,
    sendSms: async () => undefined,
    sendEmail: async (p) => { captured = p; },
  });
  assert.ok(captured);
  assert.ok(!captured.subject.includes('777888'));
  assert.ok(captured.html.includes('777888') && captured.text.includes('777888'));
});
