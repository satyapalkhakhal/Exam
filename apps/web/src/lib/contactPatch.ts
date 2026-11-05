// src/lib/contactPatch.ts
// Why: the API only sends a candidate's email and mobile masked. The edit form may send
// them back only after "Show" loaded the real values, so a masked value can never be saved.

export function contactPatch(revealed: boolean, v: { email: string; mobile: string }): { email?: string; mobile?: string | null } {
  if (!revealed) return {};
  const mobile = v.mobile.trim();
  return { email: v.email.trim().toLowerCase(), mobile: mobile === '' ? null : mobile };
}
