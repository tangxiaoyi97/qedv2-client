import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config/index.js';

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
