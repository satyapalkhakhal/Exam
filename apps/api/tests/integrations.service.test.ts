import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemConfigService, type SystemConfigRepository } from '../src/modules/systemConfig/systemConfig.service.js';
import { createIntegrationsService, type AuditEntry } from '../src/modules/integrations/integrations.service.js';
import { MessagingError } from '../src/modules/messaging/messaging.errors.js';
import { isChannelReady, type SmsConfig } from '../src/modules/messaging/messaging.config.js';
import { open } from '../src/infrastructure/crypto/secretBox.js';
import { AppError } from '../src/shared/errors.js';
import { SmsConfigInputSchema, EmailConfigInputSchema } from '@exam/shared';

function fakeRepo(): SystemConfigRepository & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async findByKey(key) {
      return rows.has(key) ? { key, value: rows.get(key) } : null;
    },
    async upsert(key, value) {
      rows.set(key, value);
    },
  };
}

function setup(overrides: Partial<Parameters<typeof createIntegrationsService>[0]> = {}) {
  const repo = fakeRepo();
  const config = createSystemConfigService(repo);
  const audits: AuditEntry[] = [];
  const sent: unknown[] = [];
  const service = createIntegrationsService({
    config,
    audit: async (e) => {
      audits.push(e);
    },
    sendSms: async (p) => {
      sent.push(p);
    },
    sendEmail: async (p) => {
      sent.push(p);
    },
    countCandidatesWithoutMobile: async () => 3,
    ...overrides,
  });
  return { repo, service, audits, sent };
}

const smsInput = {
  enabled: true,
  baseUrl: 'https://gw.example.com/sms',
  authToken: 'Basic super-secret-token-1234',
  userName: 'u',
  apiKey: 'api-key-9876',
  otpTemplate: 'OTP {otp}',
};

test('GET never contains a plaintext secret and masks last4', async () => {
  const { service } = setup();
  await service.updateSms(smsInput, 'admin-1');
  const view = await service.get();
  const json = JSON.stringify(view);
  assert.ok(!json.includes('super-secret-token'));
  assert.ok(!json.includes('api-key-9876'));
  assert.deepEqual(view.sms.authToken, { set: true, last4: '1234' });
  assert.deepEqual(view.sms.apiKey, { set: true, last4: '9876' });
  assert.deepEqual(view.email.sendMailToken, { set: false, last4: null });
});

test('secrets are stored sealed, not plain', async () => {
  const { service, repo } = setup();
  await service.updateSms(smsInput, 'admin-1');
  const stored = repo.rows.get('sms.arihant') as Record<string, string>;
  assert.match(stored.authToken!, /^v1:/);
  assert.equal(open(stored.authToken!), smsInput.authToken);
  assert.equal(stored.userName, 'u');
});

test('a PUT without authToken (omitted or null) keeps the old sealed value', async () => {
  const { service, repo } = setup();
  await service.updateSms(smsInput, 'admin-1');
  const { authToken: _drop, ...rest } = smsInput;
  await service.updateSms({ ...rest, userName: 'u2' }, 'admin-1');
  await service.updateSms({ ...rest, authToken: null }, 'admin-1');
  const after = repo.rows.get('sms.arihant') as Record<string, string>;
  assert.match(after.authToken!, /^v1:/);
  assert.equal(open(after.authToken!), smsInput.authToken);
  assert.equal(after.userName, 'u');
  const view = await service.get();
  assert.deepEqual(view.sms.authToken, { set: true, last4: '1234' });
});

test('a PUT with a new secret replaces it', async () => {
  const { service, repo } = setup();
  await service.updateSms(smsInput, 'admin-1');
  await service.updateSms({ ...smsInput, authToken: 'brand-new-5555' }, 'admin-1');
  const stored = repo.rows.get('sms.arihant') as Record<string, string>;
  assert.equal(open(stored.authToken!), 'brand-new-5555');
});

test('every PUT and test-send is audited without secrets', async () => {
  const { service, audits } = setup();
  await service.updateSms(smsInput, 'admin-1');
  await service.updateEmail(
    { enabled: true, baseUrl: 'https://api.zatpatmail.com', sendMailToken: 'mailtok-0000', fromAddress: 'a@b.com', fromName: 'N', replyTo: '' },
    'admin-1',
  );
  await service.testSms('9876543210', 'admin-1');
  await service.testEmail('x@y.com', 'admin-1');
  assert.equal(audits.length, 4);
  assert.ok(audits.every((a) => a.adminId === 'admin-1'));
  const blob = JSON.stringify(audits);
  assert.ok(!blob.includes('super-secret') && !blob.includes('mailtok') && !blob.includes('9876543210') && !blob.includes('x@y.com'));
});

test('testSms sends to 91 + mobile with the template and reports delivered', async () => {
  const { service, sent } = setup();
  await service.updateSms(smsInput, 'admin-1');
  assert.deepEqual(await service.testSms('9876543210', 'admin-1'), { delivered: true });
  assert.deepEqual(sent[0], { to: '919876543210', message: 'OTP 000000' });
});

test('a provider failure becomes a 502 carrying the provider message, and is audited', async () => {
  const { service, audits } = setup({
    sendEmail: async () => {
      throw new MessagingError('bad token', 'X', false);
    },
  });
  await assert.rejects(
    () => service.testEmail('x@y.com', 'admin-1'),
    (e: unknown) => e instanceof AppError && e.statusCode === 502 && e.message === 'bad token',
  );
  assert.equal(audits.length, 1);
});

test('a seeded row with blank (unsealed) secrets reads as not set and does not throw', async () => {
  const { service, repo } = setup();
  repo.rows.set('sms.arihant', { enabled: false, baseUrl: 'https://x', authToken: '', userName: '', apiKey: '', otpTemplate: '' });
  repo.rows.set('email.zatpatmail', { enabled: false, baseUrl: 'https://y', token: '', fromAddress: '', fromName: 'N', replyTo: '' });
  const config = createSystemConfigService(repo);
  const raw = await config.getConfig<SmsConfig>('sms.arihant');
  assert.equal(raw.authToken, '');
  assert.equal(isChannelReady(raw), false);
  const view = await service.get();
  assert.deepEqual(view.sms.authToken, { set: false, last4: null });
  assert.deepEqual(view.email.sendMailToken, { set: false, last4: null });
  assert.ok(view.sms.otpTemplate.includes('{otp}'));
});

test('changing baseUrl requires every secret fresh, else 400 and nothing stored', async () => {
  const { service, repo } = setup();
  await service.updateSms(smsInput, 'a');
  const before = repo.rows.get('sms.arihant');
  const { authToken: _t, ...noToken } = smsInput;
  for (const body of [{ ...noToken }, { ...smsInput, apiKey: null }]) {
    await assert.rejects(
      () => service.updateSms({ ...body, baseUrl: 'https://other.example.com/sms' }, 'a'),
      (e: unknown) => e instanceof AppError && e.statusCode === 400 && e.code === 'VALIDATION_ERROR' && e.message === 'Re-enter the credentials when changing the base URL',
    );
  }
  assert.equal(repo.rows.get('sms.arihant'), before);
  await service.updateSms({ ...smsInput, baseUrl: 'https://other.example.com/sms' }, 'a');
  const em = { enabled: true, baseUrl: 'https://mail.example.com', fromAddress: 'a@b.com', fromName: '', replyTo: '' };
  await service.updateEmail({ ...em, sendMailToken: 'tok-1111' }, 'a');
  await assert.rejects(() => service.updateEmail({ ...em, baseUrl: 'https://evil.example.com' }, 'a'), AppError);
  await service.updateEmail({ ...em, sendMailToken: null }, 'a');
});

test('baseUrl schema: https only, no loopback/private/link-local/localhost', () => {
  const ok = (u: string) => SmsConfigInputSchema.safeParse({ ...smsInput, baseUrl: u }).success;
  assert.equal(ok('https://gw.example.com/x'), true);
  assert.equal(ok('https://8.8.8.8/x'), true);
  assert.equal(ok('https://172.32.0.1/x'), true);
  for (const bad of [
    'http://gw.example.com/x', 'ftp://gw.example.com', 'https://localhost/x', 'https://app.localhost/x',
    'https://127.0.0.1/x', 'https://127.1/x', 'https://2130706433/x', 'https://10.1.2.3/x', 'https://172.16.0.1/x',
    'https://172.31.255.255/x', 'https://192.168.1.1/x', 'https://169.254.169.254/x', 'https://0.0.0.0/x',
    'https://localhost./x', 'https://foo.localhost./x', 'https://LOCALHOST../x', 'https://127.0.0.1./x', 'https://[::1]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x', 'not a url',
  ]) assert.equal(ok(bad), false, bad);
  assert.equal(EmailConfigInputSchema.safeParse({ enabled: true, baseUrl: 'http://api.zatpatmail.com', fromAddress: '', fromName: '', replyTo: '' }).success, false);
});

test('a secret sent as empty string keeps the stored one', async () => {
  const { service, repo } = setup();
  await service.updateSms(smsInput, 'a');
  await service.updateSms({ ...smsInput, authToken: '', apiKey: '  ' }, 'a');
  const stored = repo.rows.get('sms.arihant') as Record<string, string>;
  assert.equal(open(stored.authToken!), smsInput.authToken);
  assert.equal(open(stored.apiKey!), smsInput.apiKey);
  await assert.rejects(
    () => service.updateSms({ ...smsInput, authToken: '', baseUrl: 'https://other.example.com/sms' }, 'a'),
    (e: unknown) => e instanceof AppError && e.statusCode === 400,
  );
});

test('a non-empty otpTemplate must contain {otp}', () => {
  const parse = (otpTemplate: string) => SmsConfigInputSchema.safeParse({ ...smsInput, otpTemplate });
  assert.equal(parse('Your code is 1234').success, false);
  assert.equal(parse('Your code is {otp}').success, true);
  assert.equal(parse('').success, true);
});

test('last4 is null for secrets shorter than 8 chars', async () => {
  const { service } = setup();
  await service.updateSms({ ...smsInput, authToken: 'abc1234', apiKey: '12345678' }, 'a');
  const view = await service.get();
  assert.deepEqual(view.sms.authToken, { set: true, last4: null });
  assert.deepEqual(view.sms.apiKey, { set: true, last4: '5678' });
});

test('GET reports how many candidates have no mobile (they can only get email OTPs)', async () => {
  const { service } = setup({ countCandidatesWithoutMobile: async () => 7 });
  const view = await service.get();
  assert.equal(view.candidatesWithoutMobile, 7);
});

test('email CC list: normalised, de-duplicated, invalid or too many rejected', () => {
  const ok = { enabled: true, baseUrl: 'https://api.zatpatmail.com', fromAddress: '', fromName: '', replyTo: '' };
  const parsed = EmailConfigInputSchema.parse({ ...ok, ccAddresses: ' hr@x.test ; lead@x.test,\nHR@x.test , ' });
  assert.equal(parsed.ccAddresses, 'hr@x.test, lead@x.test');
  assert.equal(EmailConfigInputSchema.parse(ok).ccAddresses, '');
  const bad = EmailConfigInputSchema.safeParse({ ...ok, ccAddresses: 'hr@x.test, not-an-email' });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error?.issues), /Not a valid email: not-an-email/);
  const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.test`).join(',');
  assert.equal(EmailConfigInputSchema.safeParse({ ...ok, ccAddresses: many }).success, false);
});
