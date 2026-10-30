// src/lib/startFlow.ts
// Why: the dashboard's Start button involves a slow step (location capture, up to 15 s or
// while a permission prompt is open) before the request. A pure reducer keeps "locating"
// (which blocks double clicks) and the re-ask alert testable outside React.

import type { LocationFailure } from './geolocation';

/** SAVE_FAILED: the browser gave a location but recording it failed; still retryable. */
export type StartAlert = LocationFailure | 'SAVE_FAILED';

export interface StartFlowState {
  locating: boolean;
  alert: StartAlert | null;
  error: string | null;
}

export type StartFlowAction =
  | { type: 'begin' }
  | { type: 'settled' }
  | { type: 'locationProblem'; permission: LocationFailure }
  | { type: 'saveFailed' }
  | { type: 'recovered' }
  | { type: 'failed'; message: string };

export const initialStartFlow: StartFlowState = { locating: false, alert: null, error: null };

export function startFlowReducer(s: StartFlowState, a: StartFlowAction): StartFlowState {
  switch (a.type) {
    case 'begin':
      // Ignored while already locating, so a second click cannot restart the flow.
      return s.locating ? s : { locating: true, alert: null, error: null };
    case 'settled':
      return { ...s, locating: false };
    case 'locationProblem':
      return { locating: false, alert: a.permission, error: null };
    case 'saveFailed':
      return { locating: false, alert: 'SAVE_FAILED', error: null };
    case 'recovered':
      return { ...s, locating: false, alert: null };
    case 'failed':
      return { ...s, locating: false, error: a.message };
  }
}
