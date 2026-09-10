import { defineStore } from 'pinia';
import { canonicalServiceBaseUrl, type CompetencyCatalog, type CompetencyLocale, type CoreClient } from '@qed2/core-logic';

export interface CompetencyCatalogSource { baseUrl: string; client: CoreClient }

const CACHE_LIMIT = 8;
const CATALOG_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 30_000;

interface Entry {
  pending?: Promise<CompetencyCatalog | null>;
  value?: CompetencyCatalog | null;
  expiresAt: number;
}

/** Public, endpoint-specific content; no account data or persistent copy. */
export const useCompetencyCatalogStore = defineStore('competencyCatalog', () => {
  const cache = new Map<string, Entry>();

  function load(source: CompetencyCatalogSource, locale: CompetencyLocale, force = false): Promise<CompetencyCatalog | null> {
    if (locale !== 'de' && locale !== 'en') return Promise.reject(new TypeError('Unsupported competency locale'));
    let key: string;
    try { key = `${canonicalServiceBaseUrl(source.baseUrl)}\n${locale}`; }
    catch (cause) { return Promise.reject(cause); }
    const existing = cache.get(key);
    if (existing) {
      // Touch the entry for bounded LRU retention, including an in-flight read.
      cache.delete(key);
      cache.set(key, existing);
      if (existing.pending) return existing.pending;
      if (!force && existing.expiresAt > Date.now()) return Promise.resolve(existing.value!);
    }
    const entry: Entry = { expiresAt: 0 };
    const client = source.client;
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    entry.pending = Promise.resolve().then(() => client.getCompetencyCatalog(locale)).then((value) => {
      // An evicted/cleared response must not reinsert itself after a newer read.
      if (cache.get(key) === entry) {
        entry.value = value;
        entry.expiresAt = Date.now() + (value === null ? MISSING_TTL_MS : CATALOG_TTL_MS);
        delete entry.pending;
      }
      return value;
    }, (cause: unknown) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw cause;
    });
    return entry.pending;
  }

  function clear(): void { cache.clear(); }

  return { load, clear };
});
