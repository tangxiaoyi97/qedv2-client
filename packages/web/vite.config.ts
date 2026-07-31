import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
// Node-only helper (untyped .mjs, declared ambiently in src/env.d.ts) shared
// with the changelog archive step so the injected commit and the archived
// file name always match.
import { resolveCommit, resolveVersion } from './scripts/commit.mjs';
import { resolveChannel, resolveEndpoints } from './scripts/channel.mjs';
// The manifest lives next to it so a test can assert its colors against the
// theme — vite-plugin-pwa silently fills omitted fields with its own defaults.
import { PWA_MANIFEST } from './scripts/pwa-manifest.mjs';

/**
 * Release channel, chosen at build time.
 *  stable  → GitHub Pages, qed.barcarolle.studio (production core + server)
 *  preview → self-hosted :1408, qed-pv.barcarolle.studio
 *            (qedcore-pv :1709 + qedsync-pv :2810)
 * The two must never share an origin: same origin means one IndexedDB, and a
 * preview build with a changed archive shape would sync corruption into real
 * accounts with a perfectly valid checksum.
 */
const CHANNEL = resolveChannel();
const ENDPOINTS = resolveEndpoints();

// Static build deploys to GitHub Pages behind the custom domain
// qed.barcarolle.studio, i.e. served from the root path.
export default defineConfig({
  base: '/',
  // Build-identifying commit, read at runtime for the changelog-on-update
  // dialog (a static site can't query git — it must be baked in).
  define: {
    __APP_COMMIT__: JSON.stringify(resolveCommit()),
    /*
     * Release channel. `preview` builds carry a sentinel that the production
     * deploy workflow greps for — the guard cannot key on the word "preview"
     * alone, because the answer-preview feature already uses it ~24 times.
     */
    __QED2_CHANNEL__: JSON.stringify(CHANNEL),
    __QED2_CHANNEL_SENTINEL__: JSON.stringify(`QED2-CHANNEL:${CHANNEL}`),
    // Empty string = fall back to the compiled-in production default, so a
    // stable build never contains a preview host name at all.
    __QED2_DEFAULT_CORE__: JSON.stringify(ENDPOINTS.core),
    __QED2_DEFAULT_SERVER__: JSON.stringify(ENDPOINTS.server),
    // Single source of truth for the displayed app version — no more
    // hand-synced APP_VERSION constant in services.ts.
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      // The manifest icons are precached automatically; these two are
      // referenced only from index.html and would otherwise be missing offline.
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: PWA_MANIFEST(CHANNEL),
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
