import { effectScope, nextTick, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, type CompetencyCatalog } from '@qed2/core-logic';
import { setUiLocale } from '@qed2/ui';
import { useCompetencyDetailsDialog } from '../src/composables/useCompetencyDetailsDialog.js';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/stores/competencies.js', () => ({ useCompetencyCatalogStore: () => mocks }));
const scopes: ReturnType<typeof effectScope>[] = [];
function setup() {
  const source = shallowRef({ baseUrl: 'https://core-a.test', client: new CoreClient('https://core-a.test') });
  const scope = effectScope();
  scopes.push(scope);
  const dialog = scope.run(() => useCompetencyDetailsDialog(() => source.value))!;
  return { dialog, source };
}
function deferred() {
  let resolve!: (catalog: CompetencyCatalog | null) => void;
  const promise = new Promise<CompetencyCatalog | null>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); }
afterEach(() => { scopes.splice(0).forEach((scope) => scope.stop()); mocks.load.mockReset(); setUiLocale('de'); });

describe('competency dialog request ownership', () => {
  it('ignores a slow language response and preserves the app language', async () => {
    const de = deferred();
    const en = deferred();
    mocks.load.mockReturnValueOnce(de.promise).mockReturnValueOnce(en.promise);
    const { dialog } = setup();
    dialog.open({ code: 'AG 1.1' });
    dialog.changeLocale('en');
    const english = { locale: 'en' } as CompetencyCatalog;
    en.resolve(english);
    await settle();
    de.resolve({ locale: 'de' } as CompetencyCatalog);
    await settle();
    expect(dialog.catalog.value).toEqual(english);
    expect(dialog.loading.value).toBe(false);
    dialog.close();
    mocks.load.mockResolvedValue(null);
    dialog.open({ code: 'AG 1.2' });
    expect(dialog.locale.value).toBe('de');
  });

  it('invalidates responses on close and on reopening another competency', async () => {
    const first = deferred();
    mocks.load.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
    const { dialog } = setup();
    dialog.open({ code: 'AG 1.1', description: 'old' });
    dialog.close();
    dialog.open({ code: 'FA 1.1', description: 'new' });
    await settle();
    first.resolve({ locale: 'de' } as CompetencyCatalog);
    await settle();
    expect(dialog.code.value).toBe('FA 1.1');
    expect(dialog.fallbackDescription.value).toBe('new');
    expect(dialog.catalog.value).toBeNull();
  });

  it('reloads for a changed Core endpoint without displaying the previous response', async () => {
    const old = deferred();
    mocks.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(null);
    const { dialog, source } = setup();
    dialog.open({ code: 'AG 1.1' });
    source.value = { baseUrl: 'https://core-b.test', client: new CoreClient('https://core-b.test') };
    await settle();
    old.resolve({ locale: 'de' } as CompetencyCatalog);
    await settle();
    expect(mocks.load).toHaveBeenLastCalledWith(source.value, 'de', false);
    expect(dialog.catalog.value).toBeNull();
  });

  it('offers a forced retry after failure without losing the question fallback', async () => {
    mocks.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null);
    const { dialog } = setup();
    dialog.open({ code: 'AG 1.1', description: 'Question description' });
    await settle();
    expect(dialog.error.value).toBe(true);
    await dialog.retry();
    expect(dialog.error.value).toBe(false);
    expect(dialog.fallbackDescription.value).toBe('Question description');
    expect(mocks.load.mock.calls.at(-1)?.[2]).toBe(true);
  });
});
