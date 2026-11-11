// src/main.tsx
// App entry: query client + router.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { bindCacheToAdminSession } from './lib/sessionCache';
import { useAdminAuth } from './stores/adminAuth';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
// Signing out or switching admin drops every cached payload (blind marking: see lib/sessionCache).
bindCacheToAdminSession(useAdminAuth, queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
