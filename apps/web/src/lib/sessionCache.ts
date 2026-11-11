// src/lib/sessionCache.ts
// Why: the query cache outlives a sign-in. Without this, an Evaluator signing in on the same
// tab right after a Super Admin would briefly be served the Super Admin's cached payloads
// (dashboard rows with colleges and exam %, colleges, candidates): a blind-marking leak
// (campus dashboard review I-1). Every way a session ends (sign-out, sign-out everywhere,
// session expiry) and every sign-in goes through the admin auth store, so the cache is
// cleared whenever the signed-in admin changes, including to nobody.

import type { QueryClient } from '@tanstack/react-query';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { AdminSelf } from '@/types/auth';

const who = (a: AdminSelf | null) => (a ? `${a.id}|${a.role}` : '');

export function bindCacheToAdminSession(store: UseBoundStore<StoreApi<{ admin: AdminSelf | null }>>, qc: QueryClient): () => void {
  let current = who(store.getState().admin);
  return store.subscribe((s) => {
    const next = who(s.admin);
    if (next === current) return;
    current = next;
    qc.clear();
  });
}
