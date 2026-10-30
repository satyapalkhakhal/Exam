// src/pages/candidate/Submitted.tsx
// Why: the end of the candidate journey (design 7.6). One line and nothing else: no
// marks, no answers, no next steps.

import { CandidateSignOut } from '@/components/layout/CandidateSignOut';

export default function CandidateSubmitted() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <img src="/logo-light.svg" alt="Arihant Capital" className="h-10 w-auto" />
      <h1 className="text-lg font-semibold text-foreground">Your exam has been submitted. Thank you.</h1>
      <CandidateSignOut />
    </div>
  );
}
