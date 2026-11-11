import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { useAdminAuth } from '../src/stores/adminAuth.js';
import { bindCacheToAdminSession } from '../src/lib/sessionCache.js';
import type { AdminSelf } from '../src/types/auth.js';

const SA: AdminSelf = { id: 'sa-1', name: 'SA', email: 'sa@x.test', role: 'SUPER_ADMIN' as AdminSelf['role'] };
const EV: AdminSelf = { id: 'ev-1', name: 'EV', email: 'ev@x.test', role: 'EVALUATOR' as AdminSelf['role'] };
const DASH = ['admin', 'dashboard'];

test('signing out or switching admin clears cached data, so an Evaluator never sees a Super Admin payload (review I-1)', () => {
  const qc = new QueryClient();
  const unbind = bindCacheToAdminSession(useAdminAuth, qc);
  useAdminAuth.getState().setAdmin(SA);
  qc.setQueryData(DASH, [{ collegeName: 'IIT Guwahati', examPctSum: 400 }]);
  // The same admin again (e.g. /me after login) keeps the cache.
  useAdminAuth.getState().setAdmin({ ...SA });
  assert.ok(qc.getQueryData(DASH), 'same admin keeps the cache');
  // Sign-out (and session expiry, sign-out-everywhere: they all clear the store).
  useAdminAuth.getState().clear();
  assert.equal(qc.getQueryData(DASH), undefined, 'cleared on sign-out');
  useAdminAuth.getState().setAdmin(EV);
  assert.equal(qc.getQueryData(DASH), undefined);
  // A direct switch without a sign-out in between also clears.
  qc.setQueryData(DASH, [{ roundNumber: 1 }]);
  useAdminAuth.getState().setAdmin(SA);
  assert.equal(qc.getQueryData(DASH), undefined, 'cleared on switching admin');
  unbind();
  useAdminAuth.getState().clear();
});
