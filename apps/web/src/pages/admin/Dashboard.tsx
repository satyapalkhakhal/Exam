// src/pages/admin/Dashboard.tsx
// Why: admin home (design §9): one card per job role with the pipeline counts.
// Evaluators see the same counts.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard, type RoleCounts } from '@/api/admin/dashboard';

const STATS: Array<[keyof RoleCounts, string]> = [
  ['refApplicantCount', 'Reference applicants'],
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
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
      {isPending && <p className="text-sm text-muted-foreground" role="status">Loading…</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error.message}</p>}
      {data && data.length === 0 && <p className="text-sm text-muted-foreground">No job roles yet.</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((r) => (
          <Card key={r.jobRoleId}>
            <CardHeader>
              <CardTitle>{r.jobRoleName}</CardTitle>
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
