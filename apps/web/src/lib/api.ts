// src/lib/api.ts
// Why: one place that talks to the API. It unwraps the {success,data} envelope,
// turns failures into ApiError, and on a 401 silently rotates the session once via
// /api/{area}/auth/refresh before giving up and sending the user to the right login.
// Only a refresh the server answers with 401 ends the session; a failed or 5xx
// refresh surfaces as a retryable 503.
// `path` is relative to /api/{area}, e.g. apiFetch('admin', '/auth/me').

import type { ApiResponse, ErrorCode } from '@exam/shared';
import { useAdminAuth } from '../stores/adminAuth.js';
import { useCandidateAuth } from '../stores/candidateAuth.js';

export type ApiArea = 'admin' | 'candidate';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiInit extends Omit<RequestInit, 'body'> {
  /** JSON body; serialised and sent with a content-type header. */
  json?: unknown;
  body?: BodyInit | null;
  /** Skip the redirect to the login page when the session cannot be recovered (used by the guards). */
  noRedirect?: boolean;
}

const LOGIN_PATH: Record<ApiArea, string> = { admin: '/admin/login', candidate: '/login' };

const NO_REFRESH = new Set(['/auth/login', '/auth/verify-otp', '/auth/request-otp', '/auth/refresh', '/auth/logout']);

// One refresh at a time per area, so a burst of 401s rotates the token once
// (rotation invalidates the old refresh token, a second parallel call would fail).
//   ok           the session was rotated; retry the request
//   unauthorized the server rejected the refresh token (401)
//   transient    a network error or 5xx: the session may well be fine, so it is
//                never cleared for this (a Redis blip must not log a candidate
//                out mid-exam); the caller sees a 503 and retries like offline
export type RefreshOutcome = 'ok' | 'unauthorized' | 'transient';
const refreshing: Partial<Record<ApiArea, Promise<RefreshOutcome>>> = {};

function refreshSession(area: ApiArea): Promise<RefreshOutcome> {
  const existing = refreshing[area];
  if (existing) return existing;
  const p = fetch(`/api/${area}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then((r): RefreshOutcome => (r.ok ? 'ok' : r.status === 401 ? 'unauthorized' : 'transient'))
    .catch((): RefreshOutcome => 'transient')
    .finally(() => {
      delete refreshing[area];
    });
  refreshing[area] = p;
  return p;
}

/**
 * Another tab sharing the cookie jar may have rotated the refresh token a moment
 * before ours was sent (the server answers that reuse with a plain 401, without
 * revoking the login). Its Set-Cookie lands shortly after, so one delayed retry
 * of the original request recovers before we give up on the session.
 */
export const TAB_RACE_RETRY_MS = 1_000;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function clearSession(area: ApiArea, noRedirect: boolean | undefined): void {
  if (area === 'admin') useAdminAuth.getState().clear();
  else useCandidateAuth.getState().clear();
  const loc = (globalThis as { location?: Location }).location;
  if (!noRedirect && loc && loc.pathname !== LOGIN_PATH[area]) {
    loc.assign(LOGIN_PATH[area]);
  }
}

async function request(area: ApiArea, path: string, init: ApiInit): Promise<Response> {
  const { json, noRedirect: _n, headers, ...rest } = init;
  const h = new Headers(headers);
  let body = rest.body;
  if (json !== undefined) {
    h.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }
  return fetch(`/api/${area}${path}`, { ...rest, body, headers: h, credentials: 'include' });
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  let payload: ApiResponse<T> | null = null;
  try {
    payload = (await res.json()) as ApiResponse<T>;
  } catch {
    payload = null;
  }
  if (payload && payload.success) return payload.data;
  if (payload && !payload.success) {
    throw new ApiError(res.status, payload.error.code, payload.error.message, payload.error.details);
  }
  throw new ApiError(res.status, res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR', 'Unexpected server response');
}

export async function apiFetch<T>(area: ApiArea, path: string, init: ApiInit = {}): Promise<T> {
  let res = await request(area, path, init);
  // The credential endpoints return 401 for bad input; refreshing there is pointless. /me is not one of them.
  if (res.status === 401 && !NO_REFRESH.has(path)) {
    const outcome = await refreshSession(area);
    if (outcome === 'transient') {
      throw new ApiError(503, 'INTERNAL_ERROR', 'Could not reach the server. Retrying…');
    }
    if (outcome === 'unauthorized') await pause(TAB_RACE_RETRY_MS);
    res = await request(area, path, init);
    if (res.status === 401) {
      clearSession(area, init.noRedirect);
      throw new ApiError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
    }
  }
  return unwrap<T>(res);
}
