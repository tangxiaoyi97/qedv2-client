import 'fake-indexeddb/auto';
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuestionSummary } from '@qed2/core-logic';
import BrowseView from '../src/routes/BrowseView.vue';

/** Mirrors BrowseView's constants — kept local so a change has to be deliberate. */
const PAGE_SIZE = 200;
const ROW_WINDOW = 60;
const TOTAL = 450; // → 3 pages, i.e. two that must go out concurrently

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

async function mountBrowse(): Promise<{ host: HTMLElement; unmount: () => void }> {
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
  return { host, unmount: () => app.unmount() };
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
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('requests the remaining pages concurrently at the core page-size cap', async () => {
    const { pages, release } = stubPagedCore();
    const { unmount } = await mountBrowse();
    await settle();

    // Page 1 reports the total, so pages 2 and 3 must both already be in
    // flight while neither has answered — a sequential walk would show only
    // page 2 here.
    expect(pages).toEqual([1, 2, 3]);
    release();
    await settle();

    const sizes = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([url]) => new URL(String(url)).searchParams.get('pageSize'));
    expect(new Set(sizes)).toEqual(new Set([String(PAGE_SIZE)]));
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
});
