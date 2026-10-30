// src/components/layout/CandidateSignOut.tsx
// Why: revokes the candidate's refresh-token family server-side (POST /auth/logout) before
// leaving, so signing out on a shared machine really ends the session. Not shown on the exam screen.

import { useNavigate } from 'react-router';
import { apiFetch } from '@/lib/api';
import { useCandidateAuth } from '@/stores/candidateAuth';

export function CandidateSignOut() {
  const navigate = useNavigate();
  const clear = useCandidateAuth((s) => s.clear);
  const onClick = async () => {
    try {
      await apiFetch('candidate', '/auth/logout', { method: 'POST', noRedirect: true });
    } catch {
      // The cookies expire on their own; leaving the screen is what matters.
    }
    clear();
    navigate('/login', { replace: true });
  };
  return (
    <button type="button" onClick={() => void onClick()} className="text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Sign out
    </button>
  );
}
