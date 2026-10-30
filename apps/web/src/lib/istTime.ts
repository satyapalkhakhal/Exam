// src/lib/istTime.ts
// Why: exam windows are entered and shown in IST (UTC+05:30, no DST) whatever the
// admin's browser zone is, and travel to the API as ISO UTC. A fixed offset keeps the
// conversion pure and independent of the machine's timezone.

const IST_OFFSET_MS = 330 * 60_000;

/** ISO UTC -> value for <input type="datetime-local"> in IST. */
export function isoToIstInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** datetime-local value read as IST -> ISO UTC (null when empty/invalid). */
export function istInputToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const t = Date.parse(`${local}:00.000Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t - IST_OFFSET_MS).toISOString();
}

export function formatIst(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} IST`;
}
