// src/pages/admin/AdminPlaceholder.tsx
// Why: lazy-loaded stand-in for admin pages built in later tasks. Keeping it in
// the admin chunk proves the candidate bundle never ships admin code.

import { ComingSoon } from '../ComingSoon';

export default function AdminPlaceholder({ title }: { title: string }) {
  return <ComingSoon title={title} />;
}
