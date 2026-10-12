import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Dev only: lets the app save renders to a local folder for visual QA (POST /__qa/save?name=x.png). */
function qaSave(): Plugin {
  return {
    name: 'qa-save',
    apply: 'serve',
    configureServer(server) {
      const dir = process.env.QA_DIR || join(process.cwd(), '.qa');
      server.middlewares.use('/__qa/save', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name')?.replace(/[^\w.-]/g, '') || 'render.png';
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    qaSave(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Crystal – Glasobjekte',
        short_name: 'Crystal',
        description: 'Mundgeblasene 3D-Glasobjekte gestalten und als Wallpaper exportieren',
        theme_color: '#0b0b10',
        background_color: '#0b0b10',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  server: { host: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
