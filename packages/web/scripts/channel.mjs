/**
 * Release channel, resolved at build time from the environment.
 *
 * Node-only, like commit.mjs: the web package compiles without @types/node, so
 * anything touching `process` lives in an untyped .mjs helper that is declared
 * ambiently in src/env.d.ts.
 *
 * Channels differ in endpoints, manifest identity and a sentinel string.
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
  const endpoints = {
    core: process.env.QED2_DEFAULT_CORE ?? 'https://qedcore-pv.barcarolle.studio',
    server: process.env.QED2_DEFAULT_SERVER ?? 'https://qedsync-pv.barcarolle.studio',
  };
  for (const [service, endpoint] of Object.entries(endpoints)) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error(`Invalid preview ${service} endpoint`); }
    const hostname = url.hostname.replace(/\.+$/, '');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    if (
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash ||
      (['qedcore.barcarolle.studio', 'qedsync.barcarolle.studio', 'qed.barcarolle.studio'].includes(hostname)
        && process.env.QED2_PREVIEW_REPLACES_STABLE !== 'true')
    ) throw new Error(`Preview ${service} must use an isolated HTTPS service or local loopback`);
  }
  return endpoints;
}
