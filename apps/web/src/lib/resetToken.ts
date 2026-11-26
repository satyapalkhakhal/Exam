// src/lib/resetToken.ts
// Why: the admin reset link carries its one-time token in the URL fragment
// (#token=…), which browsers never send to a server or put in referrers.

export function readResetToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token');
  return token ? token : null;
}
