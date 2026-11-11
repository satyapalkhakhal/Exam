// src/pages/admin/Dashboard.tsx
// Why: admin home (design §9): one card per drive (spec 2026-11-10: one round of a
// job profile at one college, one batch) with the pipeline counts. Evaluators get
// one card per round instead, without the college or batch (blind marking).
// A Super Admin gets the campus hiring dashboard instead (spec 2026-11-11): filters, KPIs,
// institution / profile / internship reports and a ranking, built from the same payload.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useDashboard, type DriveCounts } from '@/api/admin/dashboard';
import { AdminRole } from '@exam/shared';
import { CampusDashboard } from '@/components/admin/CampusDashboard';
import { useAdminAuth } from '@/stores/adminAuth';

// Live counts only. The role's reference applicant figure is a typed-in number, not data, so it stays off the cards.
const STATS: Array<[keyof DriveCounts, string]> = [
  ['imported', 'Imported'],
  ['notStarted', 'Not started'],
  ['inProgress', 'In progress'],
  ['submitted', 'Submitted'],
  ['autoSubmitted', 'Auto-submitted'],
  ['pendingEvaluation', 'Pending evaluation'],
  ['evaluated', 'Evaluated'],
  ['shortlisted', 'Shortlisted'],
  ['rejected', 'Rejected'],
];

export default function Dashboard() {
  const { data, isPending, error } = useDashboard();
  const isSa = useAdminAuth((s) => s.admin?.role) === AdminRole.SUPER_ADMIN;
  if (isSa && data && data.length > 0) return <CampusDashboard drives={data} />;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
      {isPending && <p className="text-sm text-muted-foreground" role="status">Loading…</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {data && data.length === 0 && <p className="text-sm text-muted-foreground">No drives yet.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((r) => (
          <Card key={r.driveId ?? `${r.jobRoleId}-${r.roundNumber}`}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <span>{r.jobRoleName}</span>
                {r.jobProfileType === 'INTERNSHIP' && <Badge variant="secondary">Internship</Badge>}
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Round {r.roundNumber}
                {r.collegeShortCode && ` · ${r.collegeShortCode}`}
                {r.batch && ` · ${r.batch}`}
              </p>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {STATS.map(([k, label]) => (
                  <div key={k} className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="font-semibold tabular-nums text-foreground">{r[k]}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
