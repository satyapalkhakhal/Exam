// src/lib/drivePicker.ts
// Why: pure helpers behind the drive picker and the round selects (spec
// 2026-11-10): job profile -> round -> drive (college · batch). Kept free of React
// so they are unit-tested.

import type { DriveDto, JobRoleDto } from '@exam/shared';

/** The round's drives, inactive ones only when asked (history filters). */
export function drivesForRound(drives: DriveDto[], roundId: string, includeInactive: boolean): DriveDto[] {
  return drives.filter((d) => d.roundId === roundId && (includeInactive || d.active));
}

/** A drive inside its round's select: "IITG · Nov 2026", marked when inactive. */
export const driveOptionLabel = (d: DriveDto): string => `${d.college.shortCode} · ${d.batch}${d.active ? '' : ' (inactive)'}`;

/** "Quant Analyst · Round 1", "Quant Analyst (Internship) · Round 1". */
export const jobProfileLabel = (r: Pick<JobRoleDto, 'name' | 'type'>): string => (r.type === 'INTERNSHIP' ? `${r.name} (Internship)` : r.name);

export interface RoundOption {
  id: string;
  jobRoleId: string;
  label: string;
}

/** Every round of every job profile, in list order (job profiles as given, rounds by number). */
export function roundOptions(roles: JobRoleDto[]): RoundOption[] {
  return roles.flatMap((r) =>
    [...r.rounds].sort((a, b) => a.roundNumber - b.roundNumber).map((round) => ({ id: round.id, jobRoleId: r.id, label: `${jobProfileLabel(r)} · Round ${round.roundNumber}` })),
  );
}

/** Where a drive sits (for a picker opened on an existing value). Null when not found. */
export function locateDrive(roles: JobRoleDto[], driveId: string): { jobRoleId: string; roundId: string; drive: DriveDto } | null {
  for (const r of roles) {
    for (const round of r.rounds) {
      const drive = round.drives?.find((d) => d.id === driveId);
      if (drive) return { jobRoleId: r.id, roundId: round.id, drive };
    }
  }
  return null;
}

/** Every drive of the job profiles (Super Admin data). */
export const allDrives = (roles: JobRoleDto[]): DriveDto[] => roles.flatMap((r) => r.rounds.flatMap((round) => round.drives ?? []));

/** The batch part of a drive display name ("… · IITG · Nov 2026" -> "Nov 2026"). */
export function batchOf(displayName: string, collegeShortCode: string): string {
  const marker = ` · ${collegeShortCode} · `;
  const at = displayName.lastIndexOf(marker);
  return at < 0 ? '' : displayName.slice(at + marker.length);
}

/** What "Copy questions" did, shown before the dialog closes. */
export function copyResultText(r: { copied: number; skippedDuplicates?: number }): string {
  if (r.copied === 0) return 'The source round has no active questions; nothing was copied.';
  return `${r.copied} question${r.copied === 1 ? '' : 's'} copied.`;
}
