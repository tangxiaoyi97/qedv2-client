import { describe, expect, it } from 'vitest';
import {
  accountStorageIdentity,
  canonicalServiceBaseUrl,
  DEFAULT_CONFIG,
  mergeConfig,
  sanitizeClientConfigOverrides,
} from '../src/config/index.js';

/**
 * mergeConfig used to rebuild its result from four named keys, so anything
 * added to ClientConfig later was silently discarded on every save.
 */
describe('mergeConfig keeps fields it does not know about', () => {
  it('preserves preferences alongside the endpoints', () => {
    const merged = mergeConfig({ aiLanguage: 'English', aiCustomInstructions: 'Be brief.' });
    expect(merged.aiLanguage).toBe('English');
    expect(merged.aiCustomInstructions).toBe('Be brief.');
    // …and still normalises the URLs it does know about.
    expect(merged.coreBaseUrl).toBe(DEFAULT_CONFIG.coreBaseUrl);
  });

  it('still strips trailing slashes from an overridden endpoint', () => {
    expect(mergeConfig({ serverBaseUrl: 'https://x.example//' }).serverBaseUrl).toBe(
      'https://x.example',
    );
  });
});

describe('service endpoint identity', () => {
  it('canonicalizes HTTPS and loopback development endpoints', () => {
    expect(canonicalServiceBaseUrl('https://EXAMPLE.com:443/api/')).toBe('https://example.com/api');
    expect(canonicalServiceBaseUrl('http://127.0.0.1:1022/')).toBe('http://127.0.0.1:1022');
    expect(canonicalServiceBaseUrl('http://[::1]:1022/')).toBe('http://[::1]:1022');
  });

  it('rejects plaintext remote and ambiguous URLs', () => {
    expect(() => canonicalServiceBaseUrl('http://example.com')).toThrow('HTTPS');
    expect(() => canonicalServiceBaseUrl('https://user:secret@example.com')).toThrow('credentials');
    expect(() => canonicalServiceBaseUrl('https://example.com?tenant=a')).toThrow('query');
    expect(() => canonicalServiceBaseUrl('https://example.com/?')).toThrow('query');
    expect(() => canonicalServiceBaseUrl('https://example.com/path#')).toThrow('query');
  });

  it('namespaces the same remote user by canonical Server identity', () => {
    const a = accountStorageIdentity('https://server-a.example/', 'same-user');
    expect(accountStorageIdentity('https://SERVER-A.example:443', 'same-user')).toBe(a);
    expect(accountStorageIdentity('https://server-b.example', 'same-user')).not.toBe(a);
    expect(a).toMatch(/^account-v1-[0-9a-f]{64}$/u);
  });
});

describe('persisted config validation', () => {
  it('drops malformed roots and non-string fields before merge', () => {
    expect(sanitizeClientConfigOverrides(['not', 'an', 'object'])).toEqual({
      value: {},
      invalidFields: ['(root)'],
    });
    expect(sanitizeClientConfigOverrides({
      serverBaseUrl: 7,
      coreBaseUrl: 'https://core.example',
      aiPreferPool: 'yes',
    })).toEqual({
      value: { coreBaseUrl: 'https://core.example' },
      invalidFields: ['serverBaseUrl', 'aiPreferPool'],
    });
    expect(() => mergeConfig({ serverBaseUrl: 7 } as never)).not.toThrow();
    expect(mergeConfig({ serverBaseUrl: 7 } as never).serverBaseUrl)
      .toBe(DEFAULT_CONFIG.serverBaseUrl);
  });
});
