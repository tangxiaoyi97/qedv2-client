/// <reference types="vite/client" />

/** Build-time commit sha injected by vite.config (define). */
declare const __APP_COMMIT__: string;

/** Node-only build helper (see scripts/commit.mjs) — typed for vite.config. */
declare module '*/commit.mjs' {
  export function resolveCommit(): string;
}
