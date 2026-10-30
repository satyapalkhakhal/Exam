// examAvailability.ts
// Whether a role's exam can be started right now, as a pure function so the API
// (start guard) and the web (badges, banners) agree. The window only gates
// starting; both bounds are inclusive and either may be absent.

export type ExamAvailability = 'OPEN' | 'NOT_OPEN' | 'BEFORE_WINDOW' | 'AFTER_WINDOW';

export interface AvailabilitySettings {
  isOpen: boolean;
  windowStart: Date | string | null;
  windowEnd: Date | string | null;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

export function examAvailability(settings: AvailabilitySettings, now: Date): ExamAvailability {
  if (!settings.isOpen) return 'NOT_OPEN';
  const t = now.getTime();
  if (settings.windowStart !== null && t < ms(settings.windowStart)) return 'BEFORE_WINDOW';
  if (settings.windowEnd !== null && t > ms(settings.windowEnd)) return 'AFTER_WINDOW';
  return 'OPEN';
}
