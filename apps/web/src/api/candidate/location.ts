// src/api/candidate/location.ts
// Why: every location attempt, granted or not, is recorded server-side (plan Task 6,
// POST /api/candidate/location) so HR can see who struggled. The response fields beyond
// `locationCaptured` are an ASSUMED extension (ip/browser/os/deviceType) for the confirm panel.

import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { LocationResult } from '@/lib/geolocation';

export type LocationStage = 'LOGIN' | 'EXAM_START';
export type LocationPayload = LocationResult & { stage: LocationStage };

export interface LocationRecorded {
  locationCaptured?: boolean;
  ip?: string;
  browser?: string;
  os?: string;
  deviceType?: string;
}

export function useRecordLocation() {
  return useMutation({
    mutationFn: (body: LocationPayload) =>
      apiFetch<LocationRecorded>('candidate', '/location', { method: 'POST', json: body }),
  });
}
