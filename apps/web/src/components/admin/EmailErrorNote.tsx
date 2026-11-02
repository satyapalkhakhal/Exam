// src/components/admin/EmailErrorNote.tsx
// Why: EMAIL_NOT_CONFIGURED needs a pointer to Integrations, other errors just show their message.

import { Link } from 'react-router';
import { isEmailNotConfigured } from '@/api/admin/emails';

export function EmailErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  if (isEmailNotConfigured(error)) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Email is not set up. Configure it in <Link to="/admin/integrations" className="underline">Integrations</Link>.
      </p>
    );
  }
  return <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : 'Something went wrong'}</p>;
}
