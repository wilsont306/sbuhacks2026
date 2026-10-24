import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// Two pages, one build: dist/host.html (the TV) and dist/join.html (any phone).
// `npm run dev` proxies /api/ws to a hub on 8080 (`npm run hub`), so the pages work unchanged in dev.
export default defineConfig({
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 700, // three.js r128 alone is ~550 kB; the host page loads once on the kiosk
    rollupOptions: { input: { host: here('host.html'), join: here('join.html') } },
  },
  server: {
    host: true,
    proxy: { '/api/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
