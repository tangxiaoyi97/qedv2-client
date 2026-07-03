/**
 * Boot smoke test: the full shell (App + router + pinia + IndexedDB adapter)
 * mounts and reaches the home view as a guest, with all services offline —
 * the guest experience must never depend on the network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import HomeView from '../src/routes/HomeView.vue';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

function stubBrowserApis(): void {
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  // all network calls fail — the app must boot anyway
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline'))),
  );
}

describe('web shell boot (guest, offline)', () => {
  it('mounts and renders the home view', async () => {
    stubBrowserApis();

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: HomeView },
        { path: '/:pathMatch(.*)*', redirect: '/' },
      ],
    });

    const app = createApp(App);
    app.use(createPinia());
    app.use(router);

    const appStore = useAppStore();
    await appStore.init();
    const progress = useProgressStore();
    await progress.init();
    const auth = useAuthStore();
    await auth.init();

    const host = document.createElement('div');
    document.body.appendChild(host);
    app.mount(host);
    await router.isReady();
    await nextTick();

    expect(host.textContent).toContain('Intelligent üben');
    expect(host.textContent).toContain('Als Gast unterwegs');
    expect(auth.isLoggedIn).toBe(false);
    expect(progress.loaded).toBe(true);

    app.unmount();
    vi.unstubAllGlobals();
  });
});
