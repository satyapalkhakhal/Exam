// src/components/layout/AdminRoute.tsx
// Why: gate for /admin/*. Rehydrates the admin from /auth/me (nothing is persisted),
// bounces to the admin login when signed out, and to the dashboard when the role
// is not allowed for this branch of the tree.

import { Navigate, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { AdminRole } from '@exam/shared';
import { apiFetch } from '@/lib/api';
import { useAdminAuth } from '@/stores/adminAuth';
import type { AdminSelf } from '@/types/auth';

export function AdminRoute({ roles }: { roles?: readonly AdminRole[] }) {
  const admin = useAdminAuth((s) => s.admin);
  const setAdmin = useAdminAuth((s) => s.setAdmin);
  const me = useQuery({
    queryKey: ['admin', 'me'],
    enabled: admin === null,
    queryFn: async () => {
      const { admin: a } = await apiFetch<{ admin: AdminSelf }>('admin', '/auth/me', { noRedirect: true });
      setAdmin(a);
      return a;
    },
  });

  if (admin === null) {
    if (me.isPending) return <div className="p-8 text-sm text-muted-foreground" role="status">Loading…</div>;
    return <Navigate to="/admin/login" replace />;
  }
  if (roles && !roles.includes(admin.role)) return <Navigate to="/admin" replace />;
  return <Outlet />;
}
