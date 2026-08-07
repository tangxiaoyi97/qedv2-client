import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreRuntimePort, QuestionSummary, ShellPort } from '@qed2/core-logic';
import BrowseView from '../src/routes/BrowseView.vue';
import { ports } from '../src/services.js';
import { usePracticeStore } from '../src/stores/practice.js';

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
    parts: [{ id: `q-${i}-a`, label: 'a', format: '2 aus 5', competencies: [], hasFigures: false }],
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
function stubPagedCore(): { pages: number[]; release: () => void } {
  const pages: number[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
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

async function mountBrowse(): Promise<{
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
  const app = createApp(BrowseView);
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
    ports.coreRuntime = originalCoreRuntime;
    ports.shell = originalShell;
    vi.unstubAllGlobals();
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
    expect(local).toBeDefined();
    expect(host.textContent).toContain('Ein Quellenwechsel löscht keine Antworten oder Speicherstände');
    const pagesBeforeSwitch = pages.length;
    local?.click();
    await vi.waitFor(() => expect(selectSource).toHaveBeenCalledWith('local'));
    await vi.waitFor(() => expect(pages.length).toBeGreaterThanOrEqual(pagesBeforeSwitch + 3));

    expect(local?.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('Lokale Aufgabenbank · offline verfügbar');
    // The source transition invalidates the module cache; old list requests
    // cannot be reused just because the route component stayed mounted.
    expect(pages.slice(pagesBeforeSwitch)).toEqual([1, 2, 3]);
    unmount();
  });

  it('does not navigate until the prepared session has finished its asynchronous owner capture', async () => {
    const { release } = stubPagedCore();
    const { host, router, unmount } = await mountBrowse();
    release();
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row').length).toBeGreaterThan(0));

    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const practice = usePracticeStore();
    const startPrepared = vi.spyOn(practice, 'startPrepared').mockImplementation(async () => gate);
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.includes('Auswahl üben'));
    expect(button).toBeDefined();

    button!.click();
    await vi.waitFor(() => expect(startPrepared).toHaveBeenCalledOnce());
    expect(startPrepared).toHaveBeenCalledWith(
      BANK.map((question) => question.id),
      expect.stringMatching(/^(?:local|remote)$/u),
      BANK_COMMIT,
    );
    expect(router.currentRoute.value.path).toBe('/questions');

    releaseStart();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    unmount();
  });
});
