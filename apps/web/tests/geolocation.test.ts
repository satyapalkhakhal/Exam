import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requestLocation } from '../src/lib/geolocation.js';

type Success = (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void;
type Failure = (e: { code: number }) => void;

const g = globalThis as Record<string, unknown>;
const origNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const origSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');

function stub(nav: unknown, secure = true) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
}

afterEach(() => {
  if (origNav) Object.defineProperty(globalThis, 'navigator', origNav);
  else delete g.navigator;
  if (origSecure) Object.defineProperty(globalThis, 'isSecureContext', origSecure);
  else delete g.isSecureContext;
});

const failing = (code: number) => ({
  geolocation: { getCurrentPosition: (_s: Success, f: Failure) => f({ code }) },
});

test('error code 1 -> DENIED', async () => {
  stub(failing(1));
  assert.deepEqual(await requestLocation(), { permission: 'DENIED' });
});

test('error code 2 -> UNAVAILABLE', async () => {
  stub(failing(2));
  assert.deepEqual(await requestLocation(), { permission: 'UNAVAILABLE' });
});

test('error code 3 -> TIMEOUT', async () => {
  stub(failing(3));
  assert.deepEqual(await requestLocation(), { permission: 'TIMEOUT' });
});

test('no geolocation -> UNSUPPORTED', async () => {
  stub({});
  assert.deepEqual(await requestLocation(), { permission: 'UNSUPPORTED' });
});

test('insecure context -> UNSUPPORTED', async () => {
  stub(failing(1), false);
  assert.deepEqual(await requestLocation(), { permission: 'UNSUPPORTED' });
});

test('success maps coords, rounds accuracy and asks for high accuracy', async () => {
  let seen: Record<string, unknown> | undefined;
  stub({
    geolocation: {
      getCurrentPosition: (s: Success, _f: Failure, o: Record<string, unknown>) => {
        seen = o;
        s({ coords: { latitude: 26.1445, longitude: 91.7362, accuracy: 23.6 } });
      },
    },
  });
  assert.deepEqual(await requestLocation({ timeoutMs: 9000 }), {
    permission: 'GRANTED',
    latitude: 26.1445,
    longitude: 91.7362,
    accuracyM: 24,
  });
  assert.deepEqual(seen, { enableHighAccuracy: true, maximumAge: 0, timeout: 9000 });
});

test('a throwing geolocation is UNAVAILABLE', async () => {
  stub({ geolocation: { getCurrentPosition: () => { throw new Error('x'); } } });
  assert.deepEqual(await requestLocation(), { permission: 'UNAVAILABLE' });
});
