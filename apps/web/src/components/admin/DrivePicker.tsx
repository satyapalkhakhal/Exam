// src/components/admin/DrivePicker.tsx
// Why: one way to choose a drive everywhere (spec 2026-11-10): job profile ->
// round -> drive ("IITG · Nov 2026"). Used for imports, adding and moving
// candidates, the leaderboard and AI runs. Super Admin only (drives are hidden
// from Evaluators).

import { useEffect, useMemo, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useRoles } from '@/api/admin/roles';
import { driveOptionLabel, drivesForRound, jobProfileLabel, locateDrive } from '@/lib/drivePicker';

export interface DrivePickerProps {
  value: string | null;
  onChange: (driveId: string | null) => void;
  /** Offer "All drives" (value null), for filters. */
  allowAll?: boolean;
  /** List inactive drives too (history); marked "(inactive)". */
  includeInactive?: boolean;
  idPrefix?: string;
  /** Lay the three selects out in one row. */
  inline?: boolean;
}

export function DrivePicker({ value, onChange, allowAll = false, includeInactive = false, idPrefix = 'dp', inline = false }: DrivePickerProps) {
  const roles = useRoles();
  const list = useMemo(() => roles.data ?? [], [roles.data]);
  const located = value ? locateDrive(list, value) : null;
  const [jobRoleId, setJobRoleId] = useState(located?.jobRoleId ?? '');
  const [roundId, setRoundId] = useState(located?.roundId ?? '');

  // An outside change of `value` (e.g. a reset) moves the selects with it.
  useEffect(() => {
    if (located) {
      setJobRoleId(located.jobRoleId);
      setRoundId(located.roundId);
    }
  }, [located?.jobRoleId, located?.roundId]);

  const role = list.find((r) => r.id === jobRoleId);
  const rounds = [...(role?.rounds ?? [])].sort((a, b) => a.roundNumber - b.roundNumber);
  const round = rounds.find((r) => r.id === roundId);
  const drives = round ? drivesForRound(round.drives ?? [], round.id, includeInactive) : [];

  const pickRole = (id: string) => {
    setJobRoleId(id);
    const first = [...(list.find((r) => r.id === id)?.rounds ?? [])].sort((a, b) => a.roundNumber - b.roundNumber)[0];
    setRoundId(first?.id ?? '');
    onChange(null);
  };
  const pickRound = (id: string) => {
    setRoundId(id);
    onChange(null);
  };

  return (
    <div className={inline ? 'grid gap-3 sm:grid-cols-3' : 'space-y-3'}>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-role`}>Job profile</Label>
        <Select id={`${idPrefix}-role`} value={jobRoleId} onChange={(e) => pickRole(e.target.value)} disabled={roles.isPending}>
          <option value="">{roles.isPending ? 'Loading…' : 'Select a job profile…'}</option>
          {list.map((r) => (
            <option key={r.id} value={r.id}>{jobProfileLabel(r)}{r.active ? '' : ' (inactive)'}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-round`}>Round</Label>
        <Select id={`${idPrefix}-round`} value={roundId} onChange={(e) => pickRound(e.target.value)} disabled={!role}>
          <option value="">Select a round…</option>
          {rounds.map((r) => (
            <option key={r.id} value={r.id}>Round {r.roundNumber}{r.name ? ` · ${r.name}` : ''}</option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-drive`}>Drive (college · batch)</Label>
        <Select id={`${idPrefix}-drive`} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} disabled={!round}>
          <option value="">{allowAll ? 'All drives' : drives.length === 0 && round ? 'No drives in this round yet' : 'Select a drive…'}</option>
          {drives.map((d) => (
            <option key={d.id} value={d.id}>{driveOptionLabel(d)}</option>
          ))}
        </Select>
      </div>
      {roles.error && <p role="alert" className="text-sm text-destructive">{roles.error.message}</p>}
    </div>
  );
}
