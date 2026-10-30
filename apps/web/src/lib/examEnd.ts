// src/lib/examEnd.ts
// Why: at time-up the local answer copies are wiped (shared exam-centre PCs) only when the
// final flush got everything to the server. If anything is still unsent, including in a tab
// that was superseded, the copy stays on the device and the candidate is told so.

import type { SaveStatus } from './autosave';

export const UNSAVED_AT_TIME_UP =
  'Some of your last changes could not be sent to the server. A copy has been kept on this device.';

export function timeUpOutcome(s: { status: SaveStatus; hasUnsaved: boolean }): { clearLocal: boolean; notice: string | null } {
  const allSaved = s.status === 'saved' && !s.hasUnsaved;
  return allSaved ? { clearLocal: true, notice: null } : { clearLocal: false, notice: UNSAVED_AT_TIME_UP };
}
