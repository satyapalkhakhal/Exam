import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBrowser, detectOs } from '../src/lib/browserInfo.js';

const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1';
const SAMSUNG_CHROME =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const WIN_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

test('Edge on Windows', () => {
  assert.equal(detectBrowser(EDGE_WIN), 'edge');
  assert.equal(detectOs(EDGE_WIN), 'windows');
});

test('iPhone Safari is safari-ios / ios', () => {
  assert.equal(detectBrowser(IPHONE_SAFARI), 'safari-ios');
  assert.equal(detectOs(IPHONE_SAFARI), 'ios');
});

test('Chrome on iOS still uses the iOS Safari steps', () => {
  assert.equal(detectBrowser(IPHONE_CHROME), 'safari-ios');
});

test('Samsung Chrome is chrome-android / android', () => {
  assert.equal(detectBrowser(SAMSUNG_CHROME), 'chrome-android');
  assert.equal(detectOs(SAMSUNG_CHROME), 'android');
});

test('desktop Chrome, Safari and Firefox', () => {
  assert.equal(detectBrowser(WIN_CHROME), 'chrome');
  assert.equal(detectBrowser(MAC_SAFARI), 'safari-mac');
  assert.equal(detectOs(MAC_SAFARI), 'macos');
  assert.equal(detectBrowser(FIREFOX), 'firefox');
});

test('unknown agent', () => {
  assert.equal(detectBrowser('curl/8.0'), 'other');
  assert.equal(detectOs('curl/8.0'), 'other');
});
