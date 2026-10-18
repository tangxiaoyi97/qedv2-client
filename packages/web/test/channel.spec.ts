import { describe, expect, it } from 'vitest';
import { resolveChannel, resolveEndpoints } from '../scripts/channel.mjs';

/**
 * Module-scoped, not global: the web BUNDLE never touches `process` (it has no
 * node types for a reason). Only the build helpers in scripts/ do, and this
 * spec drives one of them directly.
 */
declare const process: { env: Record<string, string | undefined> };

/**
 * Stable and preview must never share an origin: same origin means one
 * IndexedDB, and a preview build with a changed archive shape would sync
 * corruption into real accounts carrying a valid checksum. The channel is the
 * only thing standing between those two worlds, so it fails safe.
 */
describe('release channel', () => {
  const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };

  it('is stable unless the environment says exactly "preview"', () => {
    expect(withEnv({ QED2_CHANNEL: undefined }, resolveChannel)).toBe('stable');
    expect(withEnv({ QED2_CHANNEL: '' }, resolveChannel)).toBe('stable');
    // A typo must not silently produce a preview-flavoured production build.
    for (const typo of ['Preview', 'PREVIEW', 'preview ', 'prev', 'staging', 'true']) {
      expect(withEnv({ QED2_CHANNEL: typo }, resolveChannel), typo).toBe('stable');
    }
    expect(withEnv({ QED2_CHANNEL: 'preview' }, resolveChannel)).toBe('preview');
  });

  it('compiles empty endpoints on stable, so no preview host can be in the bundle', () => {
    const endpoints = withEnv(
      {
        QED2_CHANNEL: 'stable',
        QED2_DEFAULT_CORE: 'https://qedcore-pv.barcarolle.studio',
        QED2_DEFAULT_SERVER: 'https://qedsync-pv.barcarolle.studio',
      },
      resolveEndpoints,
    );
    expect(endpoints).toEqual({ core: '', server: '' });
  });

  it('passes the preview endpoints through verbatim', () => {
    const endpoints = withEnv(
      {
        QED2_CHANNEL: 'preview',
        QED2_DEFAULT_CORE: 'https://qedcore-pv.barcarolle.studio',
        QED2_DEFAULT_SERVER: 'https://qedsync-pv.barcarolle.studio',
      },
      resolveEndpoints,
    );
    expect(endpoints.core).toBe('https://qedcore-pv.barcarolle.studio');
    expect(endpoints.server).toBe('https://qedsync-pv.barcarolle.studio');
  });

  it('defaults an explicit preview build to the isolated preview services', () => {
    const endpoints = withEnv(
      {
        QED2_CHANNEL: 'preview',
        QED2_DEFAULT_CORE: undefined,
        QED2_DEFAULT_SERVER: undefined,
      },
      resolveEndpoints,
    );
    expect(endpoints).toEqual({
      core: 'https://qedcore-pv.barcarolle.studio',
      server: 'https://qedsync-pv.barcarolle.studio',
    });
  });

  it('supports an isolated beta deployment path and local smoke endpoints', () => {
    expect(withEnv({ QED2_CHANNEL: 'preview', QED2_DEFAULT_CORE: 'https://beta.example.test/core', QED2_DEFAULT_SERVER: 'http://127.0.0.1:8080' }, resolveEndpoints))
      .toEqual({ core: 'https://beta.example.test/core', server: 'http://127.0.0.1:8080' });
  });

  it('rejects production, insecure remote, credential-bearing and malformed preview endpoints', () => {
    for (const endpoint of ['https://qedsync.barcarolle.studio', 'https://qedsync.barcarolle.studio.', 'https://qedcore.barcarolle.studio./v1', 'https://qedcore.barcarolle.studio/v1', 'http://remote.example.test', 'https://user:secret@beta.example.test', 'https://beta.example.test?key=secret', 'https://beta.example.test#fragment', '']) {
      expect(() => withEnv({ QED2_CHANNEL: 'preview', QED2_PREVIEW_REPLACES_STABLE: undefined, QED2_DEFAULT_CORE: endpoint, QED2_DEFAULT_SERVER: 'https://beta.example.test/server' }, resolveEndpoints), endpoint).toThrow();
    }
  });

  it('requires an explicit replacement deployment to reuse the existing service addresses', () => {
    const endpoints = { QED2_CHANNEL: 'preview', QED2_DEFAULT_CORE: 'https://qedcore.barcarolle.studio', QED2_DEFAULT_SERVER: 'https://qedsync.barcarolle.studio' };
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      expect(() => withEnv({ ...endpoints, QED2_PREVIEW_REPLACES_STABLE: flag }, resolveEndpoints)).toThrow();
    }
    expect(withEnv({ ...endpoints, QED2_PREVIEW_REPLACES_STABLE: 'true' }, resolveEndpoints))
      .toEqual({ core: endpoints.QED2_DEFAULT_CORE, server: endpoints.QED2_DEFAULT_SERVER });
    expect(() => withEnv({ ...endpoints, QED2_PREVIEW_REPLACES_STABLE: 'true', QED2_DEFAULT_SERVER: 'http://qedsync.barcarolle.studio' }, resolveEndpoints)).toThrow();
  });
});
