import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const apiPort = process.env.API_PORT ?? '3001';
const apiTarget = `http://localhost:${apiPort}`;

// Multi-page: main app plus optional dev harness pages owned by the FX / audio agents.
const pages: Record<string, string> = { main: resolve(import.meta.dirname, 'index.html') };
for (const name of ['fxlab', 'audiolab']) {
  const p = resolve(import.meta.dirname, `${name}.html`);
  if (existsSync(p)) pages[name] = p;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input: pages },
  },
});
