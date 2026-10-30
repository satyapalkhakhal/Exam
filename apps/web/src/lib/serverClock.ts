// src/lib/serverClock.ts
// Why: the exam deadline is server time. A candidate's device clock can be minutes
// off (or deliberately changed), so the countdown is derived from the server's
// "now" plus the local time elapsed since it was received, never from Date.now() alone.

export interface ServerClock {
  now(): number;
  remainingMs(endsAtIso: string): number;
}

export function createServerClock(
  serverNowIso: string,
  receivedAtMs: number = Date.now(),
  nowFn: () => number = Date.now,
): ServerClock {
  const serverNow = Date.parse(serverNowIso);
  const now = () => serverNow + (nowFn() - receivedAtMs);
  return {
    now,
    remainingMs: (endsAtIso) => Math.max(0, Date.parse(endsAtIso) - now()),
  };
}
