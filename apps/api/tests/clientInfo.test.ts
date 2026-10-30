import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { clientInfo } from '../src/shared/utils/clientInfo.js';

const reqOf = (ua: string | undefined, ip = '203.0.113.9'): Request =>
  ({ ip, headers: ua === undefined ? {} : { 'user-agent': ua } }) as unknown as Request;

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const WIN_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

test('iPhone Safari is a mobile iOS device', () => {
  const i = clientInfo(reqOf(IPHONE));
  assert.equal(i.deviceType, 'mobile');
  assert.equal(i.os, 'iOS');
  assert.match(i.browser, /Safari/);
  assert.equal(i.ip, '203.0.113.9');
  assert.equal(i.userAgent, IPHONE);
});

test('Windows Chrome is a desktop device', () => {
  const i = clientInfo(reqOf(WIN_CHROME));
  assert.equal(i.deviceType, 'desktop');
  assert.equal(i.os, 'Windows');
  assert.equal(i.browser, 'Chrome');
});

test('iPad is a tablet', () => {
  assert.equal(clientInfo(reqOf(IPAD)).deviceType, 'tablet');
});

test('a missing user agent and ip fall back to unknown values', () => {
  const i = clientInfo({ headers: {} } as unknown as Request);
  assert.deepEqual(i, { ip: 'unknown', userAgent: '', browser: 'Unknown', os: 'Unknown', deviceType: 'unknown' });
});

test('an oversized user agent is truncated before it is parsed or stored', () => {
  assert.equal(clientInfo(reqOf('x'.repeat(2000))).userAgent.length, 512);
});
