import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, ApiError } from '../src/lib/api.js';
import { useAdminAuth } from '../src/stores/adminAuth.js';

type Call = { url: string; init?: RequestInit };
const calls: Call[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const ok = (data: unknown) => json(200, { success: true, data });
const fail = (status: number, code: string) =>
  json(status, { success: false, error: { message: 'nope', code } });

function mockFetch(handler: (url: string, n: number) => Response) {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, calls.length);
  }) as typeof fetch;
}

beforeEach(() => {
  useAdminAuth.getState().setAdmin({ id: '1', name: 'A', email: 'a@x.com', role: 'SUPER_ADMIN' });
});

test('unwraps {success,data} and sends credentials', async () => {
  mockFetch(() => ok({ hello: 'world' }));
  const res = await apiFetch<{ hello: string }>('admin', '/users', { noRedirect: true });
  assert.deepEqual(res, { hello: 'world' });
  assert.equal(calls[0]?.url, '/api/admin/users');
  assert.equal(calls[0]?.init?.credentials, 'include');
});

test('401 -> refresh -> retry succeeds', async () => {
  let first = true;
  mockFetch((url) => {
    if (url.endsWith('/auth/refresh')) return ok({});
    if (first) {
      first = false;
      return fail(401, 'UNAUTHORIZED');
    }
    return ok({ n: 1 });
  });
  const res = await apiFetch<{ n: number }>('admin', '/users', { noRedirect: true });
  assert.deepEqual(res, { n: 1 });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/admin/users', '/api/admin/auth/refresh', '/api/admin/users'],
  );
});

test('refresh failure -> UNAUTHORIZED ApiError and store cleared', async () => {
  mockFetch((url) => (url.endsWith('/auth/refresh') ? fail(401, 'UNAUTHORIZED') : fail(401, 'UNAUTHORIZED')));
  await assert.rejects(
    () => apiFetch('admin', '/users', { noRedirect: true }),
    (e: unknown) => e instanceof ApiError && e.code === 'UNAUTHORIZED' && e.status === 401,
  );
  assert.equal(useAdminAuth.getState().admin, null);
});

test('non-401 errors surface code and message without refreshing', async () => {
  mockFetch(() => fail(403, 'FORBIDDEN'));
  await assert.rejects(
    () => apiFetch('admin', '/users', { noRedirect: true }),
    (e: unknown) => e instanceof ApiError && e.code === 'FORBIDDEN' && e.status === 403,
  );
  assert.equal(calls.length, 1);
});

test('I2: a 5xx refresh is transient: a retryable 503, and the session is kept', async () => {
  mockFetch((url) => (url.endsWith('/auth/refresh') ? fail(500, 'INTERNAL_ERROR') : fail(401, 'UNAUTHORIZED')));
  await assert.rejects(
    () => apiFetch('admin', '/users', { noRedirect: true }),
    (e: unknown) => e instanceof ApiError && e.status === 503,
  );
  assert.notEqual(useAdminAuth.getState().admin, null);
  assert.deepEqual(calls.map((c) => c.url), ['/api/admin/users', '/api/admin/auth/refresh']);
});

test('I2: a refresh that cannot reach the server is transient too', async () => {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    if (url.endsWith('/auth/refresh')) throw new TypeError('Failed to fetch');
    return fail(401, 'UNAUTHORIZED');
  }) as typeof fetch;
  await assert.rejects(
    () => apiFetch('admin', '/users', { noRedirect: true }),
    (e: unknown) => e instanceof ApiError && e.status === 503,
  );
  assert.notEqual(useAdminAuth.getState().admin, null);
});

test('I3: a 401 refresh (another tab just rotated) retries the request once and keeps the session', async () => {
  let n = 0;
  mockFetch((url) => {
    if (url.endsWith('/auth/refresh')) return fail(401, 'UNAUTHORIZED');
    n += 1;
    return n === 1 ? fail(401, 'UNAUTHORIZED') : ok({ n });
  });
  const res = await apiFetch<{ n: number }>('admin', '/users', { noRedirect: true });
  assert.deepEqual(res, { n: 2 });
  assert.notEqual(useAdminAuth.getState().admin, null);
  assert.deepEqual(calls.map((c) => c.url), ['/api/admin/users', '/api/admin/auth/refresh', '/api/admin/users']);
});
