import 'fake-indexeddb/auto';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE } from '@qed2/core-logic';
import { historyLog, localProfileStore, storage } from '../src/services.js';
import { useProgressStore } from '../src/stores/progress.js';
import HistoryView from '../src/routes/HistoryView.vue';
import ProgressView from '../src/routes/ProgressView.vue';

describe('activity chart refresh continuity', () => {
  let app: App | undefined;

  beforeEach(async () => {
    await Promise.all([STORAGE.app, STORAGE.archive, STORAGE.auth, STORAGE.history]
      .map((collection) => storage.clear(collection)));
    await localProfileStore.initialize();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
  });

  afterEach(() => {
    app?.unmount();
    app = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it.each([
    ['history', HistoryView],
    ['progress', ProgressView],
  ] as const)('keeps the %s heatmap and manual scroll position while activity reloads', async (route, component) => {
    vi.spyOn(historyLog, 'snapshot').mockResolvedValue([]);
    vi.spyOn(historyLog, 'dailyActivity').mockResolvedValue({});
    const pinia = createPinia();
    setActivePinia(pinia);
    const progress = useProgressStore();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: `/${route}`, component },
        { path: '/practice', component: { template: '<div />' } },
        { path: '/leaderboard', component: { template: '<div />' } },
      ],
    });
    await router.push(`/${route}`);
    const host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp(component);
    app.use(pinia);
    app.use(router);
    app.mount(host);
    const visibleChart = () => {
      const container = host.querySelector<HTMLElement>(route === 'history' ? '.q-heat' : '.prog__activity');
      return !!container && container.style.display !== 'none';
    };
    await vi.waitFor(() => expect(visibleChart()).toBe(true));
    const chart = host.querySelector<HTMLDivElement>('.q-heat__scroll')!;
    chart.scrollLeft = 80;
    chart.dispatchEvent(new Event('scroll'));

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (route === 'history') {
      vi.mocked(historyLog.snapshot).mockImplementation(async () => { await pending; return []; });
    } else {
      vi.mocked(historyLog.dailyActivity).mockImplementation(async () => { await pending; return {}; });
    }
    progress.historyVersion += 1;
    try {
      await vi.waitFor(() => expect(visibleChart()).toBe(false));
      expect(host.querySelector('.q-heat__scroll')).toBe(chart);
    } finally {
      release();
    }
    await vi.waitFor(() => expect(visibleChart()).toBe(true));
    await nextTick();
    expect(host.querySelector('.q-heat__scroll')).toBe(chart);
    expect(chart.scrollLeft).toBe(80);
  });
});
