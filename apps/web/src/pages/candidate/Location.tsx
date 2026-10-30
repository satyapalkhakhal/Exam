// src/pages/candidate/Location.tsx
// Why: the step between OTP and the dashboard (design 7.2a). Skipping is allowed;
// the dashboard banner and the disabled Start button keep asking.

import { useNavigate } from 'react-router';
import { AuthPageShell } from '@/components/auth/AuthPageShell';
import { LocationGate } from '@/components/location/LocationGate';

export default function Location() {
  const navigate = useNavigate();
  const go = () => navigate('/dashboard', { replace: true });
  return (
    <AuthPageShell title="Share your location" subtitle="Required before you can start your exam.">
      <LocationGate onContinue={go} onSkip={go} />
    </AuthPageShell>
  );
}
