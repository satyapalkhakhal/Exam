import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { sendSms } from '../src/modules/messaging/sms.client.js';
import { sendEmail } from '../src/modules/messaging/email.client.js';
import { MessagingError } from '../src/modules/messaging/messaging.errors.js';
import { isChannelReady, type SmsConfig, type EmailConfig } from '../src/modules/messaging/messaging.config.js';

const sms: SmsConfig = {
  enabled: true,
  baseUrl: 'https://gw.example.com/V1/sendSMS',
  authToken: 'abc',
  userName: 'u',
  apiKey: 'k',
  otpTemplate: 'Your OTP is {otp}',
};
const email: EmailConfig = {
  enabled: true,
  baseUrl: 'https://api.zatpatmail.test',
  sendMailToken: 'tok',
  fromAddress: 'noreply@example.com',
  fromName: 'Arihant',
  replyTo: '',
  ccAddresses: '',
};

interface Captured {
  options: https.RequestOptions;
  body: string;
}

// Stubs https.request: records what was sent and answers with the given status/body.
function stubHttps(status: number, responseBody = '{}'): Captured {
  const captured: Captured = { options: {}, body: '' };
  mock.method(https, 'request', ((options: https.RequestOptions, cb: (res: EventEmitter) => void) => {
    captured.options = options;
    const req = new EventEmitter() as EventEmitter & {
      write: (s: string) => void;
      end: () => void;
      setTimeout: (ms: number, fn: () => void) => void;
      destroy: () => void;
    };
    req.write = (s) => (captured.body += s);
    req.setTimeout = () => undefined;
    req.destroy = () => undefined;
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode: status, setEncoding: () => undefined });
      cb(res);
      res.emit('data', responseBody);
      res.emit('end');
    };
    return req;
  }) as unknown as typeof https.request);
  return captured;
}

afterEach(() => mock.restoreAll());

test('SMS body matches the gateway contract', async () => {
  const c = stubHttps(200);
  await sendSms({ to: '919876543210', message: 'hi' }, sms);
  assert.deepEqual(JSON.parse(c.body), [
    { UserName: 'u', APIkey: 'k', SMSType: 'OTP', messages: [{ To: '919876543210', msg: 'hi' }] },
  ]);
  assert.equal(c.options.method, 'POST');
  assert.equal(c.options.hostname, 'gw.example.com');
  assert.equal(c.options.path, '/V1/sendSMS');
});

test('SMS auth header is "Basic abc" for bare and prefixed tokens', async () => {
  for (const token of ['abc', 'Basic abc']) {
    const c = stubHttps(200);
    await sendSms({ to: '919876543210', message: 'hi' }, { ...sms, authToken: token });
    assert.equal((c.options.headers as Record<string, string>).Authorization, 'Basic abc');
    mock.restoreAll();
  }
});

test('email auth header uses C-enczapikey for bare and prefixed tokens', async () => {
  for (const token of ['tok', 'C-enczapikey tok']) {
    const c = stubHttps(200, '{"request_id":"r1"}');
    await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>x</p>', text: 'x' }, { ...email, sendMailToken: token });
    assert.equal((c.options.headers as Record<string, string>).Authorization, 'C-enczapikey tok');
    mock.restoreAll();
  }
});

test('email payload: cc only when given', async () => {
  const c = stubHttps(200, '{"request_id":"r1"}');
  await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>x</p>', text: 'x', cc: ['hr@x.test', 'lead@x.test'] }, email);
  assert.deepEqual(JSON.parse(c.body).cc, [{ email_address: { address: 'hr@x.test' } }, { email_address: { address: 'lead@x.test' } }]);
  mock.restoreAll();
  const d = stubHttps(200, '{"request_id":"r1"}');
  await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>x</p>', text: 'x' }, email);
  assert.equal('cc' in JSON.parse(d.body), false);
  mock.restoreAll();
});

test('email payload: /v1.1/email, tracking off, from/to/subject', async () => {
  const c = stubHttps(200, '{"request_id":"r1"}');
  await sendEmail({ to: 'a@b.com', subject: 'Sub', html: '<p>x</p>', text: 'x' }, { ...email, replyTo: 'hr@example.com' });
  const body = JSON.parse(c.body);
  assert.equal(c.options.path, '/v1.1/email');
  assert.equal(body.track_opens, false);
  assert.equal(body.track_clicks, false);
  assert.equal(body.subject, 'Sub');
  assert.equal(body.htmlbody, '<p>x</p>');
  assert.equal(body.textbody, 'x');
  assert.deepEqual(body.from, { address: 'noreply@example.com', name: 'Arihant' });
  assert.deepEqual(body.reply_to, [{ address: 'hr@example.com' }]);
});

test('a 4xx throws MessagingError retryable:false; 5xx is retryable', async () => {
  stubHttps(401, '{"error":{"code":"X","message":"bad token"}}');
  await assert.rejects(
    () => sendEmail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' }, email),
    (e: unknown) => e instanceof MessagingError && e.retryable === false && e.message === 'bad token',
  );
  mock.restoreAll();
  stubHttps(400);
  await assert.rejects(
    () => sendSms({ to: '919876543210', message: 'hi' }, sms),
    (e: unknown) => e instanceof MessagingError && e.retryable === false,
  );
  mock.restoreAll();
  stubHttps(503);
  await assert.rejects(
    () => sendSms({ to: '919876543210', message: 'hi' }, sms),
    (e: unknown) => e instanceof MessagingError && e.retryable === true,
  );
});

test('an unconfigured channel throws NOT_CONFIGURED without any request', async () => {
  const spy = mock.method(https, 'request');
  await assert.rejects(
    () => sendSms({ to: '919876543210', message: 'hi' }, { ...sms, userName: '' }),
    (e: unknown) => e instanceof MessagingError && e.code === 'NOT_CONFIGURED' && !e.retryable,
  );
  assert.equal(spy.mock.callCount(), 0);
});

test('isChannelReady needs enabled and every required field', () => {
  assert.equal(isChannelReady({ ...sms, userName: '' }), false);
  assert.equal(isChannelReady({ ...sms, enabled: false }), false);
  assert.equal(isChannelReady({ ...sms, apiKey: '   ' }), false);
  assert.equal(isChannelReady(sms), true);
  assert.equal(isChannelReady({ ...email, fromAddress: '' }), false);
  assert.equal(isChannelReady({ ...email, replyTo: '' }), true);
});
