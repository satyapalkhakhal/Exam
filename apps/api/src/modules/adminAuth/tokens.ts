// modules/adminAuth/tokens.ts
// Access and refresh tokens for both token kinds (admin and candidate), per
// design §13. Access: HS256 JWT, 15 min, `aud` = kind and a per-kind secret, so
// a candidate token can never pass an admin check or the reverse. Refresh: 32
// random bytes, stored only as sha256 in Redis (`exam:rt:{kind}:{hash}` ->
// {subjectId, family}). Every rotation retires the old token into a short
// "used" marker; presenting a retired token again means it was stolen or
// replayed, so the whole family (that login session) is revoked. The one
// exception is a reuse within ROTATION_GRACE_MS of the rotation: that is a
// second tab sharing the cookie jar whose refresh left before the first tab's
// new cookie landed. It gets a plain 401 (RefreshRaceError) that neither
// revokes the family nor clears cookies, and the client retries. Cookie names,
// paths and flags live here too so both auth modules set them identically.
// Evicting a subject everywhere (password reset, deactivation, role change,
// logout-all) writes a per-subject "sessions valid after" instant
// (`exam:sva:{kind}:{subjectId}`, ms): refresh families created at or before it
// are refused and deleted on their next use, and access tokens issued at or
// before it fail assertAccessCurrent. Access tokens carry `ims` (issued-at in
// ms) because the standard `iat` is whole seconds. Access tokens also carry
// their login family (`fam`); assertSessionLive refuses one whose family has
// been revoked (logout, reuse detection), so a signed-out access cookie dies
// immediately instead of living out its 15 minutes.

import crypto from 'node:crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../infrastructure/config/env.js';
import { getRedis } from '../../infrastructure/redis/redis.js';
import { AppError, unauthorized } from '../../shared/errors.js';
import { sha256 } from '../../shared/utils/hash.js';

export type TokenKind = 'admin' | 'candidate';

export interface AccessPayload {
  sub: string;
  role?: string;
  /** Refresh-token family (login session); candidate tokens carry it so location is scoped to one login. */
  fam?: string;
  /** Set by verifyAccess (from the `ims` claim, else `iat`); ignored by signAccess. */
  issuedAtMs?: number;
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS: Record<TokenKind, number> = { admin: 7 * 86_400, candidate: 12 * 3_600 };

const secretFor = (kind: TokenKind): string => (kind === 'admin' ? env.JWT_ADMIN_SECRET : env.JWT_CANDIDATE_SECRET);

export function signAccess(kind: TokenKind, payload: AccessPayload): string {
  const { issuedAtMs: _ignored, ...claims } = payload;
  return jwt.sign({ ...claims, ims: Date.now() }, secretFor(kind), {
    algorithm: 'HS256',
    audience: kind,
    expiresIn: ACCESS_TTL_SECONDS,
  });
}

export function verifyAccess(kind: TokenKind, token: string): AccessPayload {
  try {
    const decoded = jwt.verify(token, secretFor(kind), { algorithms: ['HS256'], audience: kind });
    if (typeof decoded !== 'object' || typeof decoded.sub !== 'string') throw new Error('bad payload');
    const role = (decoded as { role?: unknown }).role;
    const fam = (decoded as { fam?: unknown }).fam;
    const ims = (decoded as { ims?: unknown }).ims;
    const issuedAtMs = typeof ims === 'number' ? ims : (decoded.iat ?? 0) * 1000;
    return {
      sub: decoded.sub,
      ...(typeof role === 'string' ? { role } : {}),
      ...(typeof fam === 'string' ? { fam } : {}),
      issuedAtMs,
    };
  } catch {
    throw unauthorized();
  }
}

// ---- refresh tokens -------------------------------------------------------

const liveKey = (kind: TokenKind, hash: string) => `exam:rt:${kind}:${hash}`;
const usedKey = (kind: TokenKind, hash: string) => `exam:rt:used:${kind}:${hash}`;
const familyKey = (kind: TokenKind, family: string) => `exam:rt:fam:${kind}:${family}`;
const svaKey = (kind: TokenKind, subjectId: string) => `exam:sva:${kind}:${subjectId}`;

interface RefreshState {
  subjectId: string;
  family: string;
  /** When the family (login) was created, ms; compared with sessions-valid-after. */
  createdAt?: number;
}

/** The subject's sessions-valid-after instant (ms), or null if never revoked. */
export async function getSessionsValidAfter(kind: TokenKind, subjectId: string): Promise<number | null> {
  const raw = await getRedis().get(svaKey(kind, subjectId));
  return raw === null ? null : Number(raw);
}

/**
 * Evicts every current session of the subject: all refresh families created
 * up to now and all access tokens issued up to now stop working. Kept for the
 * longest a refresh token or access token can live, after which nothing older
 * can exist.
 */
export async function revokeAllSessions(kind: TokenKind, subjectId: string): Promise<void> {
  await getRedis().set(svaKey(kind, subjectId), String(Date.now()), 'EX', REFRESH_TTL_SECONDS[kind] + ACCESS_TTL_SECONDS);
}

/** True while the login family has not been revoked (logout, reuse, eviction) or expired. */
export async function isRefreshFamilyLive(kind: TokenKind, family: string): Promise<boolean> {
  return (await getRedis().exists(familyKey(kind, family))) === 1;
}

/**
 * The full per-request check for an already-verified access token: it must
 * name a live login family and postdate the subject's revokeAllSessions.
 */
export async function assertSessionLive(kind: TokenKind, payload: AccessPayload): Promise<void> {
  if (!payload.fam || !(await isRefreshFamilyLive(kind, payload.fam))) throw unauthorized();
  await assertAccessCurrent(kind, payload);
}

/** Throws UNAUTHORIZED if the access token predates revokeAllSessions for its subject. */
export async function assertAccessCurrent(kind: TokenKind, payload: AccessPayload): Promise<void> {
  const sva = await getSessionsValidAfter(kind, payload.sub);
  if (sva !== null && (payload.issuedAtMs ?? 0) <= sva) throw unauthorized();
}

async function store(kind: TokenKind, state: RefreshState): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const ttl = REFRESH_TTL_SECONDS[kind];
  await getRedis()
    .multi()
    .set(liveKey(kind, hash), JSON.stringify(state), 'EX', ttl)
    .sadd(familyKey(kind, state.family), hash)
    .expire(familyKey(kind, state.family), ttl)
    .exec();
  return token;
}

async function revokeFamily(kind: TokenKind, family: string): Promise<void> {
  const redis = getRedis();
  const hashes = await redis.smembers(familyKey(kind, family));
  const keys = hashes.flatMap((h) => [liveKey(kind, h), usedKey(kind, h)]);
  await redis.del(familyKey(kind, family), ...keys);
}

export async function issueRefreshToken(kind: TokenKind, subjectId: string): Promise<string> {
  return store(kind, { subjectId, family: crypto.randomUUID(), createdAt: Date.now() });
}

/** How long after a rotation a reuse of the old token is treated as a tab race, not theft. */
export const ROTATION_GRACE_MS = 30_000;

/** A reuse inside ROTATION_GRACE_MS: refused, but the login (and its cookies) stay intact. */
export class RefreshRaceError extends AppError {
  constructor() {
    super(401, 'UNAUTHORIZED', 'This session was just refreshed in another tab.');
    this.name = 'RefreshRaceError';
  }
}

/**
 * Whether a failed refresh should clear the auth cookies: only a genuine 401.
 * A 5xx (Redis or DB blip) must keep them so the client can retry, and a tab
 * race must keep them because the other tab's fresh cookies share the jar.
 */
export function shouldClearCookiesAfterRefreshError(err: unknown): boolean {
  return err instanceof AppError && err.statusCode === 401 && !(err instanceof RefreshRaceError);
}

// The "used" marker holds {family, subjectId, rotatedAt}; a bare family string
// is the older format and is still understood (with no grace).
function parseUsed(raw: string): { family: string; subjectId: string | null; rotatedAt: number | null } {
  try {
    const v = JSON.parse(raw) as { family?: unknown; subjectId?: unknown; rotatedAt?: unknown };
    if (typeof v.family === 'string') {
      return {
        family: v.family,
        subjectId: typeof v.subjectId === 'string' ? v.subjectId : null,
        rotatedAt: typeof v.rotatedAt === 'number' ? v.rotatedAt : null,
      };
    }
  } catch {
    // older format
  }
  return { family: raw, subjectId: null, rotatedAt: null };
}

export async function rotateRefreshToken(
  kind: TokenKind,
  token: string,
  opts: { onReuse?: (subjectId: string) => Promise<void>; now?: () => number } = {},
): Promise<{ token: string; subjectId: string; family: string }> {
  const redis = getRedis();
  const now = opts.now ?? Date.now;
  const hash = sha256(token);
  // GETDEL makes the hand-over atomic: two parallel refreshes with one token
  // cannot both receive a successor.
  const raw = await redis.getdel(liveKey(kind, hash));
  if (!raw) {
    const usedRaw = await redis.get(usedKey(kind, hash));
    if (usedRaw) {
      const used = parseUsed(usedRaw);
      if (used.rotatedAt !== null && now() - used.rotatedAt < ROTATION_GRACE_MS) throw new RefreshRaceError();
      await revokeFamily(kind, used.family);
      if (used.subjectId && opts.onReuse) await opts.onReuse(used.subjectId);
    }
    throw unauthorized();
  }
  const state = JSON.parse(raw) as RefreshState;
  const sva = await getSessionsValidAfter(kind, state.subjectId);
  if (sva !== null && (state.createdAt ?? 0) <= sva) {
    await revokeFamily(kind, state.family);
    throw unauthorized();
  }
  await redis.set(
    usedKey(kind, hash),
    JSON.stringify({ family: state.family, subjectId: state.subjectId, rotatedAt: now() }),
    'EX',
    REFRESH_TTL_SECONDS[kind],
  );
  return { token: await store(kind, state), subjectId: state.subjectId, family: state.family };
}

/** The login-session family of a live refresh token, or null if it is unknown or already rotated. */
export async function peekRefreshFamily(kind: TokenKind, token: string): Promise<string | null> {
  const raw = await getRedis().get(liveKey(kind, sha256(token)));
  return raw ? (JSON.parse(raw) as RefreshState).family : null;
}

/** Logout: revokes the token's whole family. Returns its subject, or null if unknown. */
export async function revokeRefreshToken(kind: TokenKind, token: string): Promise<string | null> {
  const raw = await getRedis().get(liveKey(kind, sha256(token)));
  if (!raw) return null;
  const state = JSON.parse(raw) as RefreshState;
  await revokeFamily(kind, state.family);
  return state.subjectId;
}

// ---- cookies --------------------------------------------------------------

export const COOKIES = {
  admin: { access: 'exam_admin_at', refresh: 'exam_admin_rt', path: '/api/admin' },
  candidate: { access: 'exam_cand_at', refresh: 'exam_cand_rt', path: '/api/candidate' },
} as const;

const baseCookie = (kind: TokenKind) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: env.COOKIE_SECURE,
  path: COOKIES[kind].path,
});

export function setAuthCookies(res: Response, kind: TokenKind, tokens: { access: string; refresh: string }): void {
  res.cookie(COOKIES[kind].access, tokens.access, { ...baseCookie(kind), maxAge: ACCESS_TTL_SECONDS * 1000 });
  res.cookie(COOKIES[kind].refresh, tokens.refresh, { ...baseCookie(kind), maxAge: REFRESH_TTL_SECONDS[kind] * 1000 });
}

export function clearAuthCookies(res: Response, kind: TokenKind): void {
  res.clearCookie(COOKIES[kind].access, baseCookie(kind));
  res.clearCookie(COOKIES[kind].refresh, baseCookie(kind));
}
