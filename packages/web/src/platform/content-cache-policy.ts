import type { VitePWAOptions } from 'vite-plugin-pwa';

type RuntimeCaching = NonNullable<NonNullable<VitePWAOptions['workbox']>['runtimeCaching']>;

/**
 * Match callbacks must be self-contained: Workbox serializes their source into
 * the generated service worker, where module imports/closures do not exist.
 */
export function contentRuntimeCaching(): RuntimeCaching {
  return [
    {
      urlPattern: ({ url }) => /^\/(?:admin|management)(?:\/|$)/.test(url.pathname),
      handler: 'NetworkOnly',
    },
    {
      // Health and version probes describe the running service, never cached
      // content. Both public aliases are served by Core.
      urlPattern: ({ url }) => /^\/(?:content\/)?(?:info|health)\/?$/.test(url.pathname),
      handler: 'NetworkOnly',
      options: { fetchOptions: { cache: 'no-store' } },
    },
    {
      // Only a full bank commit makes an asset URL immutable. This includes
      // historical revision assets; the mutable /content/assets alias does not.
      urlPattern: ({ url }) => /^\/content\/(?:banks|revisions)\/[a-f0-9]{40}\/assets\//i.test(url.pathname),
      handler: 'CacheFirst',
      options: {
        cacheName: 'qed2-immutable-assets',
        // Cross-origin <img> requests can be opaque even when Core supports
        // CORS. Retain their offline behavior as well as normal 200 responses.
        cacheableResponse: { statuses: [0, 200] },
        expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 },
      },
    },
    {
      // Revalidate the current-bank alias on every online read. CacheFirst
      // used to hide changed figures for up to 90 days after a bank update.
      // Preserve the existing cache name so installed PWAs can still recover
      // their previously loaded figures when the network is unavailable.
      urlPattern: ({ url }) => url.pathname.startsWith('/content/assets/'),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'qed2-assets',
        networkTimeoutSeconds: 4,
        fetchOptions: { cache: 'no-cache' },
        cacheableResponse: { statuses: [0, 200] },
        expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 90 },
      },
    },
    {
      urlPattern: ({ url }) => url.pathname.startsWith('/content/'),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'qed2-content',
        networkTimeoutSeconds: 4,
        cacheableResponse: { statuses: [200] },
        expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
      },
    },
  ];
}
