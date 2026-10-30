// src/lib/browserInfo.ts
// Why: the location help screen shows different "how to turn location on" steps per
// browser and OS (design 7.2a). Detection is a few regexes on the user agent; it only
// picks which instructions to show, so a wrong guess just falls back to generic steps.

export type BrowserKind = 'chrome' | 'edge' | 'firefox' | 'safari-mac' | 'safari-ios' | 'chrome-android' | 'other';
export type OsKind = 'windows' | 'macos' | 'android' | 'ios' | 'other';

export function detectOs(ua: string): OsKind {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return 'other';
}

export function detectBrowser(ua: string): BrowserKind {
  // Every browser on iOS is WebKit and shares Safari's settings path.
  if (detectOs(ua) === 'ios') return 'safari-ios';
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return detectOs(ua) === 'android' ? 'chrome-android' : 'chrome';
  if (/Safari\//.test(ua) && detectOs(ua) === 'macos') return 'safari-mac';
  return 'other';
}

export function currentUa(): string {
  return (globalThis as { navigator?: Navigator }).navigator?.userAgent ?? '';
}
