import { describe, expect, it } from 'vitest';
import { contentRuntimeCaching } from '../src/platform/content-cache-policy.js';

const rules = contentRuntimeCaching();
function ruleFor(path: string) {
  const url = new URL(path, 'https://core.example.test');
  return rules.find((rule) => typeof rule.urlPattern === 'function'
    && rule.urlPattern({ url, request: new Request(url), sameOrigin: false, event: {} as never }));
}

describe('PWA content cache policy', () => {
  it.each(['/info', '/health', '/content/info', '/content/health', '/content/health/?probe=1', '/admin/users', '/management/status'])(
    'never serves operational state or management data from cache: %s', (path) => {
      expect(ruleFor(path)?.handler).toBe('NetworkOnly');
    },
  );

  it('revalidates mutable figures while retaining their existing offline cache', () => {
    const rule = ruleFor('/content/assets/2026/figure.svg');
    expect(rule?.handler).toBe('NetworkFirst');
    expect(rule?.options).toMatchObject({
      cacheName: 'qed2-assets', networkTimeoutSeconds: 4,
      fetchOptions: { cache: 'no-cache' }, cacheableResponse: { statuses: [0, 200] },
    });
  });

  it.each(['banks', 'revisions'])('caches immutable %s figures by full commit', (route) => {
    const first = ruleFor(`/content/${route}/${'a'.repeat(40)}/assets/figure.svg`);
    const second = ruleFor(`/content/${route}/${'b'.repeat(40)}/assets/figure.svg`);
    expect(first?.handler).toBe('CacheFirst');
    expect(second).toBe(first);
    expect(first?.options).toMatchObject({
      cacheName: 'qed2-immutable-assets', cacheableResponse: { statuses: [0, 200] },
    });
    expect(ruleFor(`/content/${route}/main/assets/figure.svg`)?.handler).toBe('NetworkFirst');
  });

  it.each(['/content/manifest', '/content/questions/q1', '/content/search?q=math'])(
    'keeps current content fresh with offline fallback: %s', (path) => {
      expect(ruleFor(path)?.handler).toBe('NetworkFirst');
      expect(ruleFor(path)?.options?.cacheableResponse).toEqual({ statuses: [200] });
    },
  );

  it('does not cache user history or account API data', () => {
    expect(ruleFor('/me/state')).toBeUndefined();
    expect(ruleFor('/me/history')).toBeUndefined();
  });

  it('keeps callbacks executable after Workbox serializes them', () => {
    for (const rule of rules) {
      const restored = new Function(`return (${rule.urlPattern.toString()});`)() as typeof rule.urlPattern;
      expect(typeof restored).toBe('function');
      if (typeof restored === 'function') {
        expect(() => restored({ url: new URL('https://core.example.test/content/assets/figure.svg'),
          request: new Request('https://core.example.test/content/assets/figure.svg'), sameOrigin: false, event: {} as never })).not.toThrow();
      }
    }
  });
});
