// src/components/layout/CandidateRoute.tsx
// Why: gate for the candidate pages. Rehydrates the candidate from /me and sends
// signed-out visitors to /login. Location capture is enforced per page by the
// location step, which reads `locationCaptured` from the same payload.

import { Navigate, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useCandidateAuth } from '@/stores/candidateAuth';
import type { CandidateSelf } from '@/types/auth';

export function CandidateRoute() {
  const candidate = useCandidateAuth((s) => s.candidate);
  const setCandidate = useCandidateAuth((s) => s.setCandidate);
  const me = useQuery({
    queryKey: ['candidate', 'me'],
    enabled: candidate === null,
    queryFn: async () => {
      const res = await apiFetch<{ candidate: CandidateSelf } | CandidateSelf>('candidate', '/me', { noRedirect: true });
      const c = 'candidate' in res ? res.candidate : res;
      setCandidate(c);
      return c;
    },
  });

  if (candidate === null) {
    if (me.isPending) return <div className="p-8 text-sm text-muted-foreground" role="status">Loading…</div>;
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
