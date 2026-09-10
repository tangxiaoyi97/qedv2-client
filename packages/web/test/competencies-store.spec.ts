import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { CoreClient } from '@qed2/core-logic';
import type { CompetencyCatalog } from '@qed2/core-logic';
import { competencyCatalogFixture } from '../../core-logic/test/fixtures/competency-catalog.js';
import { useCompetencyCatalogStore } from '../src/stores/competencies.js';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks(); vi.useRealTimers(); });

function source(baseUrl = 'https://core.test') {
  return { baseUrl, client: new CoreClient(baseUrl) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}

describe('official competency catalog cache', () => {
  it('coalesces concurrent reads, canonicalizes origins and trailing slashes, and reuses success', async () => {
    const s = source('https://CORE.test:443/bank///');
    const pending = deferred<CompetencyCatalog | null>();
    const read = vi.spyOn(s.client, 'getCompetencyCatalog').mockReturnValue(pending.promise);
    const store = useCompetencyCatalogStore();
    const first = store.load(s, 'de');
    const second = store.load({ ...s, baseUrl: 'https://core.test/bank' }, 'de', true);
    const fixture = competencyCatalogFixture();
    pending.resolve(fixture);
    expect(await first).toEqual(fixture);
    expect(await second).toEqual(fixture);
    expect(await store.load(s, 'de')).toEqual(fixture);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('isolates simultaneous requests by endpoint path and language regardless of completion order', async () => {
    const a = source('https://core.test/a');
    const b = source('https://core.test/b');
    const slow = deferred<CompetencyCatalog | null>();
    const de = competencyCatalogFixture('de');
    const en = competencyCatalogFixture('en');
    const other = { ...de, version: '2027-05' };
    vi.spyOn(a.client, 'getCompetencyCatalog').mockImplementation((locale) => locale === 'de' ? slow.promise : Promise.resolve(en));
    vi.spyOn(b.client, 'getCompetencyCatalog').mockResolvedValue(other);
    const store = useCompetencyCatalogStore();
    const old = store.load(a, 'de');
    expect(await store.load(a, 'en')).toEqual(en);
    expect(await store.load(b, 'de')).toEqual(other);
    slow.resolve(de);
    expect(await old).toEqual(de);
    expect(await store.load(a, 'en')).toEqual(en);
    expect(await store.load(b, 'de')).toEqual(other);
  });

  it('captures the client together with the source key before an asynchronous settings change', async () => {
    const s = source('https://old.test');
    const oldClient = s.client;
    const oldCatalog = competencyCatalogFixture();
    const newClient = new CoreClient('https://new.test');
    vi.spyOn(oldClient, 'getCompetencyCatalog').mockResolvedValue(oldCatalog);
    const newRead = vi.spyOn(newClient, 'getCompetencyCatalog').mockResolvedValue({ ...oldCatalog, version: '2027-05' });
    const store = useCompetencyCatalogStore();
    const loading = store.load(s, 'de');
    s.baseUrl = 'https://new.test';
    s.client = newClient;
    expect(await loading).toEqual(oldCatalog);
    expect(newRead).not.toHaveBeenCalled();
    expect(await store.load({ baseUrl: 'https://old.test', client: oldClient }, 'de')).toEqual(oldCatalog);
  });

  it('expires successful catalogs and negative responses separately, with force refresh available', async () => {
    vi.useFakeTimers();
    const s = source();
    const fixture = competencyCatalogFixture();
    const read = vi.spyOn(s.client, 'getCompetencyCatalog').mockResolvedValueOnce(null).mockResolvedValue(fixture);
    const store = useCompetencyCatalogStore();
    expect(await store.load(s, 'de')).toBeNull();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await store.load(s, 'de')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.load(s, 'de')).toEqual(fixture);
    await vi.advanceTimersByTimeAsync(299_999);
    await store.load(s, 'de');
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await store.load(s, 'de');
    expect(read).toHaveBeenCalledTimes(3);
    await store.load(s, 'de', true);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('does not cache failures or silently return stale data after a failed forced refresh', async () => {
    const s = source();
    const fixture = competencyCatalogFixture();
    const read = vi.spyOn(s.client, 'getCompetencyCatalog').mockResolvedValueOnce(fixture)
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(fixture);
    const store = useCompetencyCatalogStore();
    await store.load(s, 'de');
    await expect(store.load(s, 'de', true)).rejects.toThrow('offline');
    expect(await store.load(s, 'de')).toEqual(fixture);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('bounds retained endpoints and does not let an evicted request replace a newer response', async () => {
    const fixture = competencyCatalogFixture();
    const slow = deferred<CompetencyCatalog | null>();
    const read = vi.spyOn(CoreClient.prototype, 'getCompetencyCatalog').mockReturnValueOnce(slow.promise).mockResolvedValue(fixture);
    const store = useCompetencyCatalogStore();
    const s = source();
    const old = store.load(s, 'de');
    await Promise.resolve();
    for (let n = 0; n < 8; n++) await store.load(source(`https://core-${n}.test`), 'de');
    const fresh = { ...fixture, version: '2027-05' };
    read.mockResolvedValue(fresh);
    expect(await store.load(s, 'de')).toEqual(fresh);
    slow.resolve(fixture);
    expect(await old).toEqual(fixture);
    expect(await store.load(s, 'de')).toEqual(fresh);
    expect(read).toHaveBeenCalledTimes(10);
  });

  it('does not repopulate a cleared cache from an earlier request', async () => {
    const s = source();
    const slow = deferred<CompetencyCatalog | null>();
    const fixture = competencyCatalogFixture();
    const read = vi.spyOn(s.client, 'getCompetencyCatalog').mockReturnValueOnce(slow.promise).mockResolvedValue(fixture);
    const store = useCompetencyCatalogStore();
    const old = store.load(s, 'de');
    await Promise.resolve();
    store.clear();
    await store.load(s, 'de');
    slow.resolve(null);
    await old;
    expect(await store.load(s, 'de')).toEqual(fixture);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
