// modules/exam/locationFlags.ts
// The location review flags (design §7.2a): start far from login, candidates
// starting close together, many candidates on one public IP. They are signals
// for HR, never an automatic disqualification (laptop location is coarse and
// can be faked). This file is the pure rule; the repository fetches the rows
// (the ±2 h start window and the per-IP candidate counts are applied there).

import { haversineMeters, type LatLng } from '../../shared/utils/geo.js';

export const LOCATION_FLAG_THRESHOLDS = {
  loginStartKm: 50,
  nearbyMeters: 100,
  sharedIpCandidates: 3,
} as const;

export type LocationFlagThresholds = { [K in keyof typeof LOCATION_FLAG_THRESHOLDS]: number };

export type LocationFlag =
  | { code: 'LOGIN_START_DISTANCE'; km: number }
  | { code: 'NEARBY_CANDIDATES'; withCandidateIds: string[]; meters: number }
  | { code: 'SHARED_IP'; ip: string; count: number };

export interface OwnLocations {
  login: LatLng | null;
  start: LatLng | null;
}

export interface OtherStart extends LatLng {
  candidateId: string;
}

export interface IpCount {
  ip: string;
  /** Distinct candidates (including this one) with an EXAM_START row from the IP. */
  count: number;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function evaluateLocationFlags(
  own: OwnLocations,
  others: OtherStart[],
  ipCounts: IpCount[],
  thresholds: LocationFlagThresholds,
): LocationFlag[] {
  const flags: LocationFlag[] = [];
  if (own.login && own.start) {
    const km = haversineMeters(own.login, own.start) / 1000;
    if (km > thresholds.loginStartKm) flags.push({ code: 'LOGIN_START_DISTANCE', km: round(km, 1) });
  }
  if (own.start) {
    const start = own.start;
    const near = new Map<string, number>();
    for (const o of others) {
      const m = haversineMeters(start, o);
      if (m > thresholds.nearbyMeters) continue;
      const prev = near.get(o.candidateId);
      if (prev === undefined || m < prev) near.set(o.candidateId, m);
    }
    if (near.size > 0) {
      flags.push({
        code: 'NEARBY_CANDIDATES',
        withCandidateIds: [...near.keys()].sort(),
        meters: Math.round(Math.min(...near.values())),
      });
    }
  }
  for (const { ip, count } of ipCounts) {
    if (count >= thresholds.sharedIpCandidates) flags.push({ code: 'SHARED_IP', ip, count });
  }
  return flags;
}

/**
 * How many other candidates started within nearbyMeters (and the ±2 h window) of
 * this one: null when this candidate has no granted start location to compare.
 */
export function nearbyCountOf(flags: LocationFlag[], hasStart: boolean): number | null {
  if (!hasStart) return null;
  const near = flags.find((f) => f.code === 'NEARBY_CANDIDATES');
  return near && near.code === 'NEARBY_CANDIDATES' ? near.withCandidateIds.length : 0;
}
