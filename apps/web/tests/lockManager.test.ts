import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLockManager } from '../src/lib/lockManager.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const dels: string[] = [];
  const m = createLockManager<string>({ post: async () => 'ok', del: (id) => dels.push(id), defer: (fn) => void setTimeout(fn, 0) });
  return { m, dels };
}

test('acquire(A1) -> acquire(A2) -> late release(A1) sends no DELETE', async () => {
  const { m, dels } = setup();
  const a1 = m.acquire('x');
  m.release('x', a1.token); // StrictMode cleanup
  const a2 = m.acquire('x'); // remount
  await tick();
  assert.deepEqual(dels, []);
  m.release('x', a2.token);
  await tick();
  assert.deepEqual(dels, ['x']);
});

test('a real unmount releases once the acquire has settled', async () => {
  const { m, dels } = setup();
  const a = m.acquire('y');
  m.release('y', a.token);
  await tick();
  assert.deepEqual(dels, ['y']);
});

test('releaseNow is skipped for a superseded token', () => {
  const { m, dels } = setup();
  const a1 = m.acquire('z');
  m.acquire('z');
  m.releaseNow('z', a1.token);
  assert.deepEqual(dels, []);
});

test('I9: renew re-POSTs the lock for the current acquisition without starting a new generation', async () => {
  const posts: string[] = [];
  const dels: string[] = [];
  const m = createLockManager<string>({ post: async (id) => (posts.push(id), 'ok'), del: (id) => dels.push(id), defer: (fn) => void setTimeout(fn, 0) });
  const a = m.acquire('r');
  assert.equal(await m.renew('r', a.token), 'ok');
  assert.deepEqual(posts, ['r', 'r']);
  // The renewal did not supersede the acquisition: its release still goes out.
  m.release('r', a.token);
  await tick();
  assert.deepEqual(dels, ['r']);
});

test('I9: a superseded acquisition does not renew', () => {
  const posts: string[] = [];
  const m = createLockManager<string>({ post: async (id) => (posts.push(id), 'ok'), del: () => undefined });
  const a1 = m.acquire('s');
  m.acquire('s');
  assert.equal(m.renew('s', a1.token), null);
  assert.equal(posts.length, 2);
});

test('I9: the renewal interval is 10 minutes, inside the 30-minute server lock', async () => {
  const { LOCK_RENEW_MS } = await import('../src/lib/lockManager.js');
  const { EVALUATION_LOCK_MINUTES } = await import('@exam/shared');
  assert.equal(LOCK_RENEW_MS, 10 * 60_000);
  assert.ok(LOCK_RENEW_MS < EVALUATION_LOCK_MINUTES * 60_000);
});
