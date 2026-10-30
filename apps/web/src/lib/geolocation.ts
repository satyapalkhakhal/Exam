// src/lib/geolocation.ts
// Why: one pure-ish wrapper over the browser Geolocation API so every screen maps
// failures to the same permission result the API stores (GRANTED/DENIED/UNAVAILABLE/
// TIMEOUT, plus UNSUPPORTED for browsers with no geolocation or a non-HTTPS page).
// It never throws: the UI branches on the result.

export type LocationFailure = 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED';
export type LocationResult =
  | { permission: 'GRANTED'; latitude: number; longitude: number; accuracyM: number }
  | { permission: LocationFailure };

export function requestLocation(opts: { timeoutMs?: number } = {}): Promise<LocationResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext;
  if (!nav || !('geolocation' in nav) || !nav.geolocation || secure === false) {
    return Promise.resolve({ permission: 'UNSUPPORTED' });
  }
  return new Promise<LocationResult>((resolve) => {
    try {
      nav.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            permission: 'GRANTED',
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracyM: Math.round(pos.coords.accuracy),
          }),
        (err) => resolve({ permission: err.code === 1 ? 'DENIED' : err.code === 3 ? 'TIMEOUT' : 'UNAVAILABLE' }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
      );
    } catch {
      resolve({ permission: 'UNAVAILABLE' });
    }
  });
}

export type PermissionState = 'granted' | 'denied' | 'prompt';

/** Subscribe to the site's geolocation permission. No-op where the Permissions API can't query it (older Safari). */
export function watchPermission(onChange: (state: PermissionState) => void): () => void {
  let status: PermissionStatus | null = null;
  let cancelled = false;
  const handler = () => {
    if (status) onChange(status.state as PermissionState);
  };
  const perms = (globalThis as { navigator?: Navigator }).navigator?.permissions;
  if (!perms || typeof perms.query !== 'function') return () => {};
  perms
    .query({ name: 'geolocation' })
    .then((s) => {
      if (cancelled) return;
      status = s;
      s.onchange = handler;
      onChange(s.state as PermissionState);
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    if (status) status.onchange = null;
  };
}
