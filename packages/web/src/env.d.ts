/// <reference types="vite/client" />

/** Build-time commit sha injected by vite.config (define). */
declare const __APP_COMMIT__: string;

/** Build-time app version (package.json) injected by vite.config (define). */
declare const __APP_VERSION__: string;

/** Node-only build helper (see scripts/commit.mjs) — typed for vite.config. */
declare module '*/commit.mjs' {
  export function resolveCommit(): string;
  export function resolveVersion(): string;
}

/** Web app manifest (see scripts/pwa-manifest.mjs) — typed for vite.config. */
declare module '*/pwa-manifest.mjs' {
  export const PWA_MANIFEST: {
    id: string;
    name: string;
    short_name: string;
    description: string;
    lang: string;
    display: 'standalone';
    start_url: string;
    scope: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
}
