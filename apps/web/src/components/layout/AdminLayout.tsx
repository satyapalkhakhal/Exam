// src/components/layout/AdminLayout.tsx
// Why: the admin shell. Sidebar pattern follows the CRM's DashboardLayout (brand,
// nav, user footer, mobile drawer); items are filtered by role so an Evaluator only
// ever sees Dashboard and Submissions.

import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import {
  LayoutDashboard, Users, FileQuestion, Settings, ClipboardCheck, Trophy, UserCog, Plug, ScrollText, LogOut, Menu, X,
  type LucideIcon,
} from 'lucide-react';
import { AdminRole } from '@exam/shared';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAdminAuth } from '@/stores/adminAuth';

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  roles: readonly AdminRole[];
  end?: boolean;
}

const ALL: readonly AdminRole[] = [AdminRole.SUPER_ADMIN, AdminRole.EVALUATOR];
const SA: readonly AdminRole[] = [AdminRole.SUPER_ADMIN];

export const ADMIN_NAV: NavItem[] = [
  { label: 'Dashboard', to: '/admin', icon: LayoutDashboard, roles: ALL, end: true },
  { label: 'Candidates', to: '/admin/candidates', icon: Users, roles: SA },
  { label: 'Questions', to: '/admin/questions', icon: FileQuestion, roles: SA },
  { label: 'Exam Settings', to: '/admin/settings', icon: Settings, roles: SA },
  { label: 'Submissions', to: '/admin/submissions', icon: ClipboardCheck, roles: ALL },
  { label: 'Leaderboard', to: '/admin/leaderboard', icon: Trophy, roles: SA },
  { label: 'Admin Users', to: '/admin/users', icon: UserCog, roles: SA },
  { label: 'Integrations', to: '/admin/integrations', icon: Plug, roles: SA },
  { label: 'Audit log', to: '/admin/audit', icon: ScrollText, roles: SA },
];

export function AdminLayout() {
  const admin = useAdminAuth((s) => s.admin);
  const clear = useAdminAuth((s) => s.clear);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const items = ADMIN_NAV.filter((i) => admin && i.roles.includes(admin.role));

  const signOut = async () => {
    try {
      await apiFetch('admin', '/auth/logout', { method: 'POST', noRedirect: true });
    } catch {
      // The cookies expire on their own; leaving the screen is what matters.
    }
    clear();
    navigate('/admin/login', { replace: true });
  };

  const signOutEverywhere = async () => {
    try {
      await apiFetch('admin', '/auth/logout-all', { method: 'POST', noRedirect: true });
    } catch {
      // Whatever the server said, leave this device.
    }
    clear();
    navigate('/admin/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex h-screen w-60 flex-col border-r border-border bg-card transition-transform duration-300 lg:sticky lg:top-0 lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-4">
          <img src="/logo-light.svg" alt="Arihant Capital" className="h-7 w-auto shrink-0 dark:hidden" />
          <img src="/logo-dark.svg" alt="Arihant Capital" className="hidden h-7 w-auto shrink-0 dark:block" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold leading-tight text-foreground">Arihant Capital</p>
            <p className="text-[10px] text-muted-foreground">Recruitment Assessment</p>
          </div>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground lg:hidden" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3" aria-label="Admin">
          {items.map(({ label, to, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn('sidebar-item', isActive ? 'sidebar-item-active' : 'sidebar-item-inactive')
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-border p-3">
          <div className="min-w-0 px-2 py-2">
            <p className="truncate text-xs font-semibold text-foreground">{admin?.name ?? admin?.email}</p>
            <p className="truncate text-[10px] capitalize text-muted-foreground">
              {admin?.role.replace(/_/g, ' ').toLowerCase()}
            </p>
          </div>
          <button className="sidebar-item sidebar-item-inactive w-full text-destructive hover:text-destructive" onClick={signOut}>
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Sign out</span>
          </button>
          <button className="sidebar-item sidebar-item-inactive w-full text-xs text-muted-foreground" onClick={signOutEverywhere}>
            <LogOut className="h-4 w-4 shrink-0" />
            <span>Sign out everywhere</span>
          </button>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card/90 px-4 backdrop-blur-sm lg:hidden">
          <button onClick={() => setOpen(true)} className="-ml-1.5 rounded-lg p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
        </header>
        <main className="flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
