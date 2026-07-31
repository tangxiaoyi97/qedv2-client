import { describe, expect, it } from 'vitest';
import { AiCache, CACHE_MAX_AGE_MS, MAX_CACHED_ANSWERS } from '../src/store/ai-cache.js';
import type { StoragePort } from '../src/ports/index.js';

/** In-memory StoragePort — the cache's only dependency. */
function memoryStorage(): StoragePort {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(ns: string, key: string) => data.get(`${ns}/${key}`) as T | undefined,
    set: async (ns: string, key: string, value: unknown) => {
      data.set(`${ns}/${key}`, value);
    },
    delete: async (ns: string, key: string) => {
      data.delete(`${ns}/${key}`);
    },
    clear: async () => data.clear(),
  } as unknown as StoragePort;
}

/**
 * Every AI call costs money and the same question gets revisited. The cache
 * used to be a Map inside the store, so a reload bought the answer again.
 */
describe('AiCache', () => {
  it('returns what it stored', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', { markdown: 'weil …' });
    expect(await cache.get('k')).toEqual({ markdown: 'weil …' });
  });

  it('misses on an unknown key rather than guessing', async () => {
    expect(await new AiCache(memoryStorage()).get('nope')).toBeUndefined();
  });

  it('replaces rather than duplicating the same key', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', 'first');
    await cache.set('k', 'second');
    expect(await cache.get('k')).toBe('second');
    expect(await cache.size()).toBe(1);
  });

  it('expires an answer older than the window', async () => {
    // Prompts and models move on; a year-old explanation is not worth replaying.
    const cache = new AiCache(memoryStorage());
    const then = new Date('2026-01-01T00:00:00Z');
    await cache.set('k', 'stale', then);
    const later = new Date(then.getTime() + CACHE_MAX_AGE_MS + 1000);
    expect(await cache.get('k', later)).toBeUndefined();
    expect(await cache.get('k', new Date(then.getTime() + 1000))).toBe('stale');
  });

  it('treats a backwards clock as a miss, not as fresh', async () => {
    const cache = new AiCache(memoryStorage());
    const now = new Date('2026-06-01T00:00:00Z');
    await cache.set('k', 'v', now);
    expect(await cache.get('k', new Date(now.getTime() - 60_000))).toBeUndefined();
  });

  it('stays bounded, dropping the oldest', async () => {
    // One document, rewritten on every miss — unbounded makes each new answer
    // O(n) work.
    const cache = new AiCache(memoryStorage());
    for (let i = 0; i < MAX_CACHED_ANSWERS + 10; i += 1) await cache.set(`k${i}`, i);
    expect(await cache.size()).toBe(MAX_CACHED_ANSWERS);
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get(`k${MAX_CACHED_ANSWERS + 9}`)).toBe(MAX_CACHED_ANSWERS + 9);
  });

  it('forgets everything on request', async () => {
    const cache = new AiCache(memoryStorage());
    await cache.set('k', 'v');
    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(await cache.get('k')).toBeUndefined();
  });
});
