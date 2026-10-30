// src/lib/countdown.ts
// Why: the exam header's countdown text and colour. Seconds round *up* so the display
// only reaches 00:00 when the server-synced remaining time is really zero.

export type CountdownTone = 'normal' | 'warning' | 'danger';

export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function countdownTone(remainingMs: number): CountdownTone {
  if (remainingMs < 2 * 60_000) return 'danger';
  if (remainingMs < 10 * 60_000) return 'warning';
  return 'normal';
}
