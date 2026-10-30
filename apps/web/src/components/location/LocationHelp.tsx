// src/components/location/LocationHelp.tsx
// Why: the alert + browser/OS-specific steps shown when location can't be read (design
// 7.2a). Browsers won't re-open a popup the user blocked, so the candidate has to be told
// where the switch is. Colour follows severity: red = blocked/unsupported, amber = fixable device state.

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { detectBrowser, detectOs, type BrowserKind, type OsKind } from '@/lib/browserInfo';
import type { LocationFailure } from '@/lib/geolocation';
import { cn } from '@/lib/utils';

const BLOCKED_STEPS: Record<BrowserKind, string[]> = {
  chrome: ['Click the lock icon at the left of the address bar.', 'Open Site settings.', 'Set Location to Allow.', 'Come back to this page.'],
  edge: ['Click the lock icon at the left of the address bar.', 'Open Permissions for this site.', 'Set Location to Allow.', 'Come back to this page.'],
  firefox: ['Click the lock icon at the left of the address bar.', 'Next to Location, remove the Blocked setting (click the x).', 'Click Try again and choose Allow.'],
  'safari-mac': ['Open Safari > Settings > Websites > Location.', 'Set this website to Allow.', 'Come back to this page.'],
  'safari-ios': ['Open Settings > Privacy & Security > Location Services and make sure it is On.', 'Scroll to Safari (or your browser) and choose While Using the App.', 'Come back to this page and reload it.'],
  'chrome-android': ['Tap the lock icon at the left of the address bar.', 'Tap Permissions > Location and choose Allow.', 'Come back to this page.'],
  other: ['Open your browser’s site settings for this page.', 'Set Location to Allow.', 'Come back to this page.'],
};

const OFF_STEPS: Record<OsKind, string[]> = {
  windows: ['Open Settings > Privacy & security > Location.', 'Turn on Location services.', 'Make sure your browser is allowed to use location.'],
  macos: ['Open System Settings > Privacy & Security > Location Services.', 'Turn on Location Services.', 'Enable it for your browser.'],
  android: ['Swipe down from the top of the screen.', 'Turn on Location in quick settings.', 'Come back and tap Try again.'],
  ios: ['Open Settings > Privacy & Security > Location Services.', 'Turn on Location Services.', 'Come back and tap Try again.'],
  other: ['Turn on location services in your device settings.', 'Come back and tap Try again.'],
};

export function LocationHelp({ permission, userAgent }: { permission: LocationFailure; userAgent: string }) {
  const red = permission === 'DENIED' || permission === 'UNSUPPORTED';
  let title: string;
  let steps: string[] = [];
  let intro: string | null = null;

  if (permission === 'DENIED') {
    title = 'Location is blocked for this site.';
    intro = 'Your browser will not ask again, so turn it on in the browser settings:';
    steps = BLOCKED_STEPS[detectBrowser(userAgent)];
  } else if (permission === 'UNAVAILABLE') {
    title = 'Your device’s location service is off.';
    intro = 'Turn it on, then try again:';
    steps = OFF_STEPS[detectOs(userAgent)];
  } else if (permission === 'TIMEOUT') {
    title = 'Couldn’t get your location — move near a window or turn on Wi-Fi.';
  } else {
    title = 'This browser can’t share location — please use the latest Chrome, Edge, Firefox or Safari.';
  }

  const Icon = red ? ShieldAlert : AlertTriangle;
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        red ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900',
      )}
    >
      <p className="flex items-start gap-2 font-semibold">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{title}</span>
      </p>
      {intro && <p className="mt-2">{intro}</p>}
      {steps.length > 0 && (
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
