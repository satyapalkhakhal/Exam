// src/components/location/LocationGate.tsx
// Why: the "Share your location" step (design 7.2a). It asks, reacts to *why* a capture
// failed, retries a timeout once on its own, re-runs capture when the browser permission
// flips to granted (so fixing it in settings needs no reload), and POSTs every attempt.

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LocationHelp } from './LocationHelp';
import { useRecordLocation, type LocationRecorded } from '@/api/candidate/location';
import { currentUa, detectBrowser, detectOs } from '@/lib/browserInfo';
import { requestLocation, watchPermission, type LocationFailure, type LocationResult } from '@/lib/geolocation';
import { useCandidateAuth } from '@/stores/candidateAuth';

type Phase =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'failed'; permission: LocationFailure }
  | { kind: 'saveFailed' }
  | { kind: 'granted'; result: Extract<LocationResult, { permission: 'GRANTED' }>; meta: LocationRecorded };

export function LocationGate({ onContinue, onSkip }: { onContinue: () => void; onSkip: () => void }) {
  const record = useRecordLocation();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busy = useRef(false);
  const done = useRef(false);
  const recordRef = useRef(record.mutateAsync);
  recordRef.current = record.mutateAsync;

  const capture = useCallback(async () => {
    if (busy.current || done.current) return;
    busy.current = true;
    setPhase({ kind: 'capturing' });
    try {
      // Failures are logged best-effort; a GRANTED result must be saved or the candidate stays locked out.
      const send = async (r: LocationResult): Promise<LocationRecorded> => {
        try {
          return await recordRef.current({ ...r, stage: 'LOGIN' });
        } catch (e) {
          if (r.permission === 'GRANTED') throw e;
          return {};
        }
      };
      try {
        let result = await requestLocation();
        let meta = await send(result);
        if (result.permission === 'TIMEOUT') {
          // One automatic retry before bothering the candidate.
          result = await requestLocation();
          meta = await send(result);
        }
        if (result.permission === 'GRANTED') {
          if (meta.locationCaptured === false) {
            setPhase({ kind: 'saveFailed' });
          } else {
            done.current = true;
            const c = useCandidateAuth.getState().candidate;
            if (c) useCandidateAuth.getState().setCandidate({ ...c, locationCaptured: true });
            setPhase({ kind: 'granted', result, meta });
          }
        } else {
          setPhase({ kind: 'failed', permission: result.permission });
        }
      } catch {
        setPhase({ kind: 'saveFailed' });
      }
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(
    () =>
      watchPermission((state) => {
        if (state === 'granted') void capture();
        else if (state === 'denied' && !busy.current && !done.current) setPhase({ kind: 'failed', permission: 'DENIED' });
      }),
    [capture],
  );

  const ua = currentUa();

  return (
    <div className="space-y-5">
      <div aria-live="polite" className="space-y-4">
        {phase.kind === 'capturing' && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking your location…
          </p>
        )}
        {phase.kind === 'saveFailed' && (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            We couldn&apos;t save your location. Please try again.
          </p>
        )}
        {phase.kind === 'failed' && <LocationHelp permission={phase.permission} userAgent={ua} />}
        {phase.kind === 'granted' && (
          <div className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
            <p className="font-semibold">Location captured.</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-green-800">Approximate area</dt>
              <dd>
                {phase.result.latitude.toFixed(3)}, {phase.result.longitude.toFixed(3)}
              </dd>
              <dt className="text-green-800">Accuracy</dt>
              <dd>about {phase.result.accuracyM} m</dd>
              {phase.meta.ip && (
                <>
                  <dt className="text-green-800">IP address</dt>
                  <dd>{phase.meta.ip}</dd>
                </>
              )}
              <dt className="text-green-800">Device</dt>
              <dd>
                {phase.meta.browser ?? detectBrowser(ua)} on {phase.meta.os ?? detectOs(ua)}
                {phase.meta.deviceType ? ` (${phase.meta.deviceType})` : ''}
              </dd>
            </dl>
          </div>
        )}
      </div>

      {(phase.kind === 'idle' || phase.kind === 'capturing') && (
        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <MapPin className="h-4 w-4" aria-hidden="true" /> Why we ask
          </p>
          <p className="mt-1 text-muted-foreground">
            We record your approximate location once at login and once at exam start. It is used only by HR to verify
            fair conduct of the assessment.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {phase.kind === 'granted' ? (
          <Button className="w-full sm:w-auto" onClick={onContinue}>
            Continue
          </Button>
        ) : (
          <>
            <Button className="w-full sm:w-auto" onClick={() => void capture()} disabled={phase.kind === 'capturing'}>
              {phase.kind === 'failed' || phase.kind === 'saveFailed' ? 'Try again' : 'Allow location'}
            </Button>
            <Button variant="ghost" className="w-full sm:w-auto" onClick={onSkip}>
              Skip for now
            </Button>
          </>
        )}
      </div>
      {phase.kind === 'failed' && (
        <p className="text-xs text-muted-foreground">You can continue without it, but you will not be able to start the exam.</p>
      )}
    </div>
  );
}
