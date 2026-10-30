// vite.config.ts
// Dev proxies /api to the exam API (4100) so cookies stay same-origin.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:4100', changeOrigin: true } },
  },
});
