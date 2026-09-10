import 'fake-indexeddb/auto';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreRuntimePort, QuestionSummary, ShellPort } from '@qed2/core-logic';
import { CompetencyDetailsDialog, provideCompetencyDetails, setUiLocale, type CompetencyDetailsHandler } from '@qed2/ui';
import BrowseView from '../src/routes/BrowseView.vue';
import { ports } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { usePracticeStore } from '../src/stores/practice.js';
import { useCompetencyDetailsDialog } from '../src/composables/useCompetencyDetailsDialog.js';
import { competencyCatalogFixture } from '../../core-logic/test/fixtures/competency-catalog.js';

/** Mirrors BrowseView's constants — kept local so a change has to be deliberate. */
const PAGE_SIZE = 200;
const ROW_WINDOW = 60;
const TOTAL = 450; // → 3 pages, i.e. two that must go out concurrently
const BANK_COMMIT = 'a'.repeat(40);
const originalCoreRuntime = ports.coreRuntime;
const originalShell = ports.shell;

function summary(i: number): QuestionSummary {
  return {
    id: `q-${i}`,
    title: `Aufgabe ${i}`,
    source: { suite: 'haupttermin-2019', year: 2019, term: 'haupttermin', part: 't1', nr: i, file: 'x.pdf' },
    status: 'converted',
    totalPoints: 1,
    playable: true,
    parts: Array.from({ length: i === 1 ? 8 : 1 }, (_, partIndex) => ({
      id: `q-${i}-${partIndex}`,
      label: String.fromCharCode(97 + partIndex),
      format: '2 aus 5',
      competencies: [{ code: 'AG 1.1', description: 'Beschreibung aus dem Test-Aufgabenstamm' }],
      hasFigures: false,
    })),
  };
}

const BANK = Array.from({ length: TOTAL }, (_, i) => summary(i + 1));

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

/** Records every /content/questions page request and can hold pages 2..N open. */
function stubPagedCore(catalog?: (locale: string) => Promise<{ status: number; body: unknown }>): { pages: number[]; release: () => void } {
  const pages: number[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const catalogLocale = /\/content\/competencies\/(de|en)$/u.exec(parsed.pathname)?.[1];
      if (catalog && catalogLocale) {
        const reply = await catalog(catalogLocale);
        return { ok: reply.status === 200, status: reply.status, statusText: 'Test', text: async () => JSON.stringify(reply.body) };
      }
      if (parsed.pathname.endsWith('/content/manifest')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ commit: BANK_COMMIT, items: {} }),
        };
      }
      if (!parsed.pathname.endsWith('/content/questions')) {
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{}' };
      }
      const page = Number(parsed.searchParams.get('page') ?? '1');
      const size = Number(parsed.searchParams.get('pageSize') ?? '0');
      pages.push(page);
      // Page 1 answers immediately; the rest stay pending so the test can see
      // whether they were all in flight at the same time.
      if (page > 1) await gate;
      const start = (page - 1) * size;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify({ items: BANK.slice(start, start + size), page, pageSize: size, total: TOTAL }),
      };
    }),
  );
  return { pages, release };
}

async function mountBrowse(details?: CompetencyDetailsHandler | 'dialog'): Promise<{
  host: HTMLElement;
  router: ReturnType<typeof createRouter>;
  unmount: () => void;
}> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/questions', component: BrowseView },
      { path: '/practice', component: { template: '<div />' } },
    ],
  });
  await router.push('/questions');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = details ? defineComponent({
    setup() {
      if (details !== 'dialog') {
        provideCompetencyDetails(details);
        return () => h(BrowseView);
      }
      const shell = useAppStore();
      const dialog = useCompetencyDetailsDialog(() => shell.pinnedCoreContent ?? {
        baseUrl: shell.coreEndpointUrl || shell.config.coreBaseUrl, client: shell.coreClient,
      });
      provideCompetencyDetails(dialog.open);
      return () => [h(BrowseView), h(CompetencyDetailsDialog, {
        open: dialog.isOpen.value, code: dialog.code.value, locale: dialog.locale.value,
        catalog: dialog.catalog.value, loading: dialog.loading.value, error: dialog.error.value,
        fallbackDescription: dialog.fallbackDescription.value,
        onClose: dialog.close, onRetry: dialog.retry, onLocaleChange: dialog.changeLocale,
      })];
    },
  }) : BrowseView;
  const app = createApp(root);
  app.use(pinia);
  app.use(router);
  app.mount(host);
  return { host, router, unmount: () => app.unmount() };
}

describe('BrowseView catalogue loading', () => {
  beforeEach(() => {
    // jsdom has no IntersectionObserver; a no-op keeps the window at its
    // initial size instead of tripping BrowseView's "reveal everything" path.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    setUiLocale('de');
    ports.coreRuntime = originalCoreRuntime;
    ports.shell = originalShell;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('requests the remaining pages concurrently at the core page-size cap', async () => {
    const { pages, release } = stubPagedCore();
    const { host, unmount } = await mountBrowse();
    await settle();

    expect(host.querySelector('.browse__sources')).toBeNull();

    // Page 1 reports the total, so pages 2 and 3 must both already be in
    // flight while neither has answered — a sequential walk would show only
    // page 2 here.
    expect(pages).toEqual([1, 2, 3]);
    release();
    await settle();

    const sizes = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([url]) => new URL(String(url)).searchParams.get('pageSize'));
    expect(new Set(sizes.filter((size) => size !== null))).toEqual(new Set([String(PAGE_SIZE)]));
    unmount();
  });

  it('renders one window of rows while reporting the full match count', async () => {
    const { release } = stubPagedCore();
    const { host, unmount } = await mountBrowse();
    await settle();
    release();
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row').length).toBeGreaterThan(0));

    expect(host.querySelectorAll('.browse__row')).toHaveLength(ROW_WINDOW);
    expect(host.textContent).toContain(`${TOTAL} Aufgaben`);
    expect(host.querySelector('.browse__more')?.textContent).toContain(String(TOTAL - ROW_WINDOW));
    expect(host.querySelector<HTMLInputElement>('.browse__search input')?.placeholder).toBe('Aufgaben suchen');

    const firstRow = host.querySelector<HTMLButtonElement>('.browse__row');
    expect(firstRow).not.toBeNull();
    expect([...firstRow!.children].map((child) => [...child.classList])).toEqual([
      ['browse__select'],
      ['browse__dots'],
      ['browse__nr'],
      expect.arrayContaining(['browse__chip']),
      ['browse__qtitle'],
      expect.arrayContaining(['browse__state', 'browse__state--new']),
    ]);
    // Ellipsis is purely visual: the full title remains in the accessible
    // button name instead of being shortened in the DOM.
    expect(firstRow?.textContent).toContain('Aufgabe 1');
    expect(firstRow?.querySelector('.browse__dots')?.getAttribute('aria-label')).toBe('8 Neu');
    expect(firstRow?.querySelectorAll('.browse__dots .q-grading-dot')).toHaveLength(1);
    expect(firstRow?.querySelector('.browse__dot-count')?.textContent).toBe('×8');
    unmount();
  });

  it('renders the source switch only for Desktop and changes it through the typed Core port', async () => {
    const { pages, release } = stubPagedCore();
    const selectSource = vi.fn(async (source: 'local' | 'remote') => ({
      baseUrl: source === 'local' ? 'http://127.0.0.1:1122/__qed2_core' : 'https://core.example',
      source,
    }));
    ports.shell = {
      capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
      onCommand: () => () => undefined,
    } satisfies ShellPort;
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async (source: 'local' | 'remote' = 'remote') => await selectSource(source),
      getStatus: async () => ({
        phase: 'ready',
        source: 'local',
        preferredSource: 'local',
        endpoint: 'http://127.0.0.1:1122/__qed2_core',
      }),
      selectSource,
    } satisfies CoreRuntimePort;
    const { host, unmount } = await mountBrowse();
    release();
    await settle();

    const local = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) =>
      button.textContent?.includes('Lokal'),
    );
    const remote = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) =>
      button.textContent?.includes('Remote'),
    );
    expect(local).toBeDefined();
    expect(local?.textContent?.trim()).toBe('Lokal');
    expect(remote?.textContent?.trim()).toBe('Remote');
    expect(host.textContent).not.toContain('Auf diesem Gerät');
    expect(host.textContent).not.toContain('Über das Netzwerk');
    expect(host.textContent).not.toContain('Ein Quellenwechsel löscht keine Antworten oder Speicherstände');
    const pagesBeforeSwitch = pages.length;
    local?.click();
    await vi.waitFor(() => expect(selectSource).toHaveBeenCalledWith('local'));
    await vi.waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(pagesBeforeSwitch + 3));

    expect(local?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('.browse__source-status')?.textContent).toMatch(/Bank |Revision wird geprüft/u);
    expect(host.textContent).not.toContain('Lokale Aufgabenbank · offline verfügbar');
    // The source transition invalidates the module cache; old list requests
    // cannot be reused just because the route component stayed mounted.
    expect(pages.slice(pagesBeforeSwitch, pagesBeforeSwitch + 3)).toEqual([1, 2, 3]);

    const app = useAppStore();
    app.coreEndpointSource = 'remote';
    app.coreRuntimeStatus = {
      phase: 'degraded',
      source: 'remote',
      preferredSource: 'local',
      endpoint: 'https://core.example',
    };
    await nextTick();
    expect(host.querySelector('.browse__source-status')?.textContent).toContain('Remote-Ersatz');
    const beforeRetry = selectSource.mock.calls.length;
    local?.click();
    await vi.waitFor(() => expect(selectSource.mock.calls.length).toBeGreaterThan(beforeRetry));

    app.online = false;
    app.coreRuntimeStatus = {
      phase: 'ready',
      source: 'remote',
      preferredSource: 'remote',
      endpoint: 'https://core.example',
    };
    await nextTick();
    expect(host.querySelector('.browse__source-status')?.textContent).toContain('Offline');

    unmount();
  });

  it.each([false, true])('only navigates after preparation while Browse is still mounted (left early: %s)', async (leftEarly) => {
    const { release } = stubPagedCore();
    const { host, router, unmount } = await mountBrowse();
    release();
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row').length).toBeGreaterThan(0));

    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const practice = usePracticeStore();
    const preparedId = '11111111-1111-4111-8111-111111111111';
    const startPrepared = vi.spyOn(practice, 'startPrepared').mockImplementation(async () => {
      await gate;
      return preparedId;
    });
    const navigate = vi.spyOn(router, 'push');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes('Üben →'));
    expect(button).toBeDefined();

    button!.click();
    await vi.waitFor(() => expect(startPrepared).toHaveBeenCalledOnce());
    expect(startPrepared).toHaveBeenCalledWith(
      BANK.map((question) => question.id),
      expect.stringMatching(/^(?:local|remote)$/u),
      BANK_COMMIT,
      expect.any(AbortSignal),
    );
    expect(router.currentRoute.value.path).toBe('/questions');
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute('aria-busy')).toBe('true');
    button!.click();
    expect(startPrepared).toHaveBeenCalledOnce();

    if (leftEarly) unmount();
    releaseStart();
    if (leftEarly) {
      await startPrepared.mock.results[0]!.value;
      await settle();
      expect(navigate).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    expect(router.currentRoute.value.query.prepared).toBe(preparedId);
    unmount();
  });

  it('switches the interface live while preserving original question titles', async () => {
    const { release } = stubPagedCore();
    const { host, unmount } = await mountBrowse();
    release();
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row').length).toBeGreaterThan(0));
    setUiLocale('en');
    await nextTick();
    expect(host.querySelector('h1')?.textContent).toBe('Questions');
    expect(host.querySelector<HTMLInputElement>('.browse__search input')?.placeholder).toBe('Search questions');
    await vi.waitFor(() => expect(host.querySelector('.browse__meta')?.textContent).toContain('450 questions'));
    const row = host.querySelector<HTMLButtonElement>('.browse__row')!;
    expect(row.textContent).toContain('Aufgabe 1');
    row.click();
    await nextTick();
    expect(row.querySelector('.browse__select')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.browse__head')?.textContent).toContain('Practice (1)');
    setUiLocale('de');
    await nextTick();
    expect(host.querySelector('h1')?.textContent).toBe('Aufgaben');
    expect(row.querySelector('.browse__select')?.getAttribute('aria-pressed')).toBe('true');
    unmount();
  });

  it('opens provider-backed chips without selecting or starting the question, while the row remains operable', async () => {
    const { release } = stubPagedCore();
    const openDetails = vi.fn();
    const { host, router, unmount } = await mountBrowse(openDetails);
    release();
    await vi.waitFor(() => expect(host.querySelector('.browse__row .q-competency-chip')).not.toBeNull());
    const row = host.querySelector<HTMLElement>('.browse__row')!;
    const select = row.querySelector<HTMLButtonElement>('.browse__select')!;
    const chip = row.querySelector<HTMLButtonElement>('.q-competency-chip')!;
    const start = vi.spyOn(usePracticeStore(), 'startPrepared').mockResolvedValue('11111111-1111-4111-8111-111111111111');
    const navigate = vi.spyOn(router, 'push');
    expect(chip.closest('button')).toBe(chip);
    expect(chip.parentElement?.closest('button')).toBeNull();
    expect(select.getAttribute('aria-pressed')).toBe('false');

    // Native double click is two clicks followed by dblclick; inner chip
    // content must stop all three before Browse's row handlers see them.
    const label = chip.querySelector<HTMLElement>('.q-chip')!;
    label.click();
    label.click();
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await settle();
    expect(openDetails).toHaveBeenCalledTimes(2);
    expect(openDetails).toHaveBeenLastCalledWith({ code: 'AG 1.1', description: 'Beschreibung aus dem Test-Aufgabenstamm' });
    expect(select.getAttribute('aria-pressed')).toBe('false');
    expect(start).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    select.click();
    await nextTick();
    expect(select.getAttribute('aria-pressed')).toBe('true');
    chip.focus();
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    chip.click();
    chip.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await settle();
    expect(openDetails).toHaveBeenCalledTimes(3);
    expect(select.getAttribute('aria-pressed')).toBe('true');
    expect(start).not.toHaveBeenCalled();
    select.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]?.[0]).toEqual(['q-1']);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    unmount();
  });

  it('opens the actual detail dialog against an older Core and preserves its question description and selection', async () => {
    const { release } = stubPagedCore();
    const { host, router, unmount } = await mountBrowse('dialog');
    release();
    await vi.waitFor(() => expect(host.querySelector('.browse__row .q-competency-chip')).not.toBeNull());
    const select = host.querySelector<HTMLButtonElement>('.browse__select')!;
    select.click();
    host.querySelector<HTMLButtonElement>('.q-competency-chip')!.click();
    await vi.waitFor(() => expect(document.querySelector('.q-competency-dialog__unavailable')).not.toBeNull());
    expect(document.querySelector('.q-competency-dialog__fallback')?.textContent).toContain('Beschreibung aus dem Test-Aufgabenstamm');
    expect(document.querySelector('.q-competency-dialog__error')).toBeNull();
    expect(select.getAttribute('aria-pressed')).toBe('true');
    expect(router.currentRoute.value.path).toBe('/questions');
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/content/competencies/de'))).toBe(true);
    document.querySelector<HTMLButtonElement>('[aria-label="Grundkompetenz schließen"]')!.click();
    await nextTick();
    expect(select.getAttribute('aria-pressed')).toBe('true');
    unmount();
  });

  it('keeps the selected dialog language when an earlier catalog response arrives last', async () => {
    let resolveGerman!: (value: { status: number; body: unknown }) => void;
    const german = new Promise<{ status: number; body: unknown }>((resolve) => { resolveGerman = resolve; });
    const english = competencyCatalogFixture('en');
    english.areas[0]!.groups[0]!.competencies[0]!.text = 'English catalog content';
    const requests: string[] = [];
    const { release } = stubPagedCore(async (locale) => {
      requests.push(locale);
      return locale === 'de' ? german : { status: 200, body: english };
    });
    const { host, unmount } = await mountBrowse('dialog');
    release();
    await vi.waitFor(() => expect(host.querySelector('.q-competency-chip')).not.toBeNull());
    host.querySelector<HTMLButtonElement>('.q-competency-chip')!.click();
    await vi.waitFor(() => expect(requests).toEqual(['de']));
    document.querySelector<HTMLButtonElement>('[aria-label="English"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('.q-competency-dialog__description')?.textContent).toBe('English catalog content'));
    const de = competencyCatalogFixture('de');
    de.areas[0]!.groups[0]!.competencies[0]!.text = 'Late German catalog content';
    resolveGerman({ status: 200, body: de });
    await settle();
    expect(requests).toEqual(['de', 'en']);
    expect(document.querySelector('.q-competency-dialog__description')?.textContent).toBe('English catalog content');
    expect(document.querySelector('[aria-label="English"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.browse__select')?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('h1')?.textContent).toBe('Aufgaben');
    unmount();
  });
});
