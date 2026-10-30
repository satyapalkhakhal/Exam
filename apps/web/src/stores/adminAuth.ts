// src/stores/adminAuth.ts
// Why: who is signed in as an admin, for the guards and the sidebar. Nothing is
// persisted; the httpOnly cookies are the session and /me rehydrates this on reload.

import { create } from 'zustand';
import type { AdminSelf } from '../types/auth.js';

interface AdminAuthState {
  admin: AdminSelf | null;
  setAdmin: (admin: AdminSelf) => void;
  clear: () => void;
}

export const useAdminAuth = create<AdminAuthState>((set) => ({
  admin: null,
  setAdmin: (admin) => set({ admin }),
  clear: () => set({ admin: null }),
}));
