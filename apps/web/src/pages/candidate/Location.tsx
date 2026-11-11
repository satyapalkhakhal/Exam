// src/pages/candidate/Location.tsx
// Why: the step between OTP and the dashboard (design 7.2a). Skipping is allowed;
// the dashboard banner and the disabled Start button keep asking.

import { useNavigate } from 'react-router';
import { ArihantPlusBanner } from '@/components/auth/ArihantPlusBanner';
import { AuthPageShell } from '@/components/auth/AuthPageShell';
import { CandidateNavBar } from '@/components/layout/CandidateNavBar';
import { LocationGate } from '@/components/location/LocationGate';

export default function Location() {
  const navigate = useNavigate();
  const go = () => navigate('/dashboard', { replace: true });
  return (
    <AuthPageShell nav={<CandidateNavBar />} title="Share your location" subtitle="Required before you can start your exam." brand="plus" aside={<ArihantPlusBanner />}>
      <LocationGate onContinue={go} onSkip={go} />
    </AuthPageShell>
  );
}
