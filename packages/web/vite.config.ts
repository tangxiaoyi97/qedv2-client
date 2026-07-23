import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
// Node-only helper (untyped .mjs, declared ambiently in src/env.d.ts) shared
// with the changelog archive step so the injected commit and the archived
// file name always match.
import { resolveCommit, resolveVersion } from './scripts/commit.mjs';

// Static build deploys to GitHub Pages behind the custom domain
// qed.barcarolle.studio, i.e. served from the root path.
export default defineConfig({
  base: '/',
  // Build-identifying commit, read at runtime for the changelog-on-update
  // dialog (a static site can't query git — it must be baked in).
  define: {
    __APP_COMMIT__: JSON.stringify(resolveCommit()),
    // Single source of truth for the displayed app version — no more
    // hand-synced APP_VERSION constant in services.ts.
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'QED2 — Matura Mathematik',
        short_name: 'QED2',
        description: 'SRDP-Mathematik üben mit intelligenter Wiederholung',
        lang: 'de',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell precached by default. Runtime caching for content so
        // previously loaded questions/figures stay readable offline.
        // (Web PWA offline = cached content only; it never runs a local core.)
        runtimeCaching: [
          {
            // Version probe must NEVER be served from cache — the settings
            // page shows these numbers to diagnose "am I up to date?", a
            // stale cached answer defeats the purpose.
            urlPattern: ({ url }) => url.pathname === '/content/info',
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/content/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'qed2-assets',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/content/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'qed2-content',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'jsdom',
    css: true,
  },
});
