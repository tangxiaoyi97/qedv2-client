/**
 * Release channel, resolved at build time from the environment.
 *
 * Node-only, like commit.mjs: the web package compiles without @types/node, so
 * anything touching `process` lives in an untyped .mjs helper that is declared
 * ambiently in src/env.d.ts.
 *
 * Channels differ ONLY in configuration — endpoints, manifest identity and a
 * sentinel string. Feature code never branches on the channel; it lives on the
 * `preview` git branch instead, so a stable build cannot contain it at all.
 */

/** Anything other than an exact "preview" is stable — fail safe, not open. */
export function resolveChannel() {
  return process.env.QED2_CHANNEL === 'preview' ? 'preview' : 'stable';
}

/**
 * Endpoint overrides for this build.
 *
 * Empty strings on stable, on purpose: the production bundle then contains no
 * preview host name at all, so the deploy guard has nothing to find because
 * there is nothing there — not because something stripped it.
 */
export function resolveEndpoints(channel = resolveChannel()) {
  // Stable is deliberately immutable. A stale shell/CI variable must not be
  // able to point the production bundle at preview (or at an arbitrary host).
  if (channel === 'stable') return { core: '', server: '' };
  return {
    core: process.env.QED2_DEFAULT_CORE ?? 'https://qedcore-pv.barcarolle.studio',
    server: process.env.QED2_DEFAULT_SERVER ?? 'https://qedsync-pv.barcarolle.studio',
  };
}
