/// <reference types="vite/client" />

/** Build-time commit sha injected by vite.config (define). */
declare const __APP_COMMIT__: string;

/** Build-time app version (package.json) injected by vite.config (define). */
declare const __APP_VERSION__: string;

/** Release channel: 'stable' | 'preview'. Injected by vite.config.ts. */
declare const __QED2_CHANNEL__: string;
/** `QED2-CHANNEL:<channel>` — the token the deploy guard greps for. */
declare const __QED2_CHANNEL_SENTINEL__: string;
/** Channel default endpoints; empty string = use the production defaults. */
declare const __QED2_DEFAULT_CORE__: string;
declare const __QED2_DEFAULT_SERVER__: string;

/** Node-only build helper (see scripts/commit.mjs) — typed for vite.config. */
declare module '*/commit.mjs' {
  export function resolveCommit(): string;
  export function resolveVersion(): string;
}

/** The changelog format (see <repo>/scripts/changelog.mjs) — shared by the
 *  release-time fold and the build-time compile, so its tests live here. */
declare module '*/changelog.mjs' {
  export interface ChangelogSection {
    version: string;
    date: string;
    body: string;
  }
  export const CHANGELOG_PREAMBLE: string;
  export function parseChangelog(text: string): ChangelogSection[];
  export function normalizeDraft(draft: string, version: string): string;
  export function formatSection(version: string, date: string, body: string): string;
  export const RELEASE_TIME_ZONE: 'Asia/Shanghai';
  export function releaseDate(date?: Date): string;
  export function prependSection(
    changelog: string,
    version: string,
    date: string,
    body: string,
  ): string | null;
  export function isPrerelease(version: string): boolean;
}

/** Node-only build helper (see scripts/channel.mjs) — typed for vite.config. */
declare module '*/channel.mjs' {
  export function resolveChannel(): 'stable' | 'preview';
  export function resolveEndpoints(): { core: string; server: string };
}

/** Web app manifest (see scripts/pwa-manifest.mjs) — typed for vite.config. */
declare module '*/pwa-manifest.mjs' {
  interface WebAppManifest {
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
  }
  /** Takes the release channel: the preview build installs as its own app. */
  export function PWA_MANIFEST(channel?: string): WebAppManifest;
}
