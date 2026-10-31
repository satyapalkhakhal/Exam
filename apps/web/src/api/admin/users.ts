// src/api/admin/users.ts
// Why: admin user management (plan Task 5): GET/POST /users, PATCH /users/:id.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminRole } from '@exam/shared';
import { apiFetch } from '@/lib/api';

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  role: AdminRole;
  active: boolean;
  lastLoginAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateAdminUser {
  name: string;
  email: string;
  mobile: string;
  role: AdminRole;
  password: string;
}

/** Any subset; `password` resets the password. */
export interface UpdateAdminUser {
  name?: string;
  /** null removes it (login codes then go by email only). */
  mobile?: string | null;
  role?: AdminRole;
  active?: boolean;
  password?: string;
}

export function useAdminUsers(page: number) {
  return useQuery({
    queryKey: ['admin', 'users', page],
    queryFn: () => apiFetch<Paged<AdminUserRow>>('admin', `/users?page=${page}`),
  });
}

/** Every admin, for pickers: the list endpoint has a fixed page size, so walk the pages. */
export function useAllAdmins() {
  return useQuery({
    queryKey: ['admin', 'users', 'all'],
    queryFn: async () => {
      const out: AdminUserRow[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await apiFetch<Paged<AdminUserRow>>('admin', `/users?page=${page}`);
        out.push(...r.items);
        if (out.length >= r.total || r.items.length === 0) break;
      }
      return out;
    },
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAdminUser) => apiFetch<AdminUserRow>('admin', '/users', { method: 'POST', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateAdminUser & { id: string }) =>
      apiFetch<AdminUserRow>('admin', `/users/${id}`, { method: 'PATCH', json: body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}
