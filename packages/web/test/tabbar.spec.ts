/**
 * Mobile tab bar contract: which slots exist, and that the active highlight
 * is the tab's own box rather than a narrower inset overlay.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import appCss from '../src/App.vue?raw';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const PASSTHROUGH = { template: '<div />' };

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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline'))),
  );
}

async function mountShell(path: string): Promise<{ host: HTMLElement; unmount: () => void }> {
  stubBrowserApis();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: PASSTHROUGH },
      { path: '/progress', component: PASSTHROUGH },
      { path: '/history', component: PASSTHROUGH },
      { path: '/questions', component: PASSTHROUGH },
      { path: '/settings', component: PASSTHROUGH },
      { path: '/leaderboard', component: PASSTHROUGH },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  });

  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  await useAppStore().init();
  await useProgressStore().init();
  await useAuthStore().init();

  const host = document.createElement('div');
  document.body.appendChild(host);
  app.mount(host);
  await router.push(path);
  await router.isReady();
  await nextTick();
  return { host, unmount: () => app.unmount() };
}

function tabLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.app__tab-label')].map((el) => el.textContent?.trim() ?? '');
}

describe('mobile tab bar', () => {
  it('offers five slots with Heute in the middle', async () => {
    const { host, unmount } = await mountShell('/');
    // Six labels did not fit a narrow phone. „Üben" is the one that goes:
    // Heute leads with the same „Programm starten" action.
    expect(tabLabels(host)).toEqual(['Übersicht', 'Verlauf', 'Heute', 'Aufgaben', 'Optionen']);
    unmount();
    vi.unstubAllGlobals();
  });

  it('marks exactly the current route active, and folds Leaderboard into Übersicht', async () => {
    for (const [path, expected] of [
      ['/', 'Heute'],
      ['/questions', 'Aufgaben'],
      ['/leaderboard', 'Übersicht'],
    ] as const) {
      const { host, unmount } = await mountShell(path);
      const active = [...host.querySelectorAll('.app__tab--active')];
      expect(active.map((el) => el.querySelector('.app__tab-label')?.textContent?.trim())).toEqual([
        expected,
      ]);
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it('tints the tab itself so a long label cannot spill out of the highlight', () => {
    // The old highlight was an `inset: 6px 8px` pseudo-element, i.e. narrower
    // than its own cell — "Übersicht" rendered past the tinted area.
    expect(appCss).not.toMatch(/\.app__tab--active::before/);
    const activeRule = /\.app__tab--active\s*\{[^}]*\}/.exec(appCss)?.[0] ?? '';
    expect(activeRule).toContain('background: var(--q-accent-bg)');
    const labelRule = /\.app__tab-label\s*\{[^}]*\}/.exec(appCss)?.[0] ?? '';
    expect(labelRule).toContain('text-overflow: ellipsis');
  });
});
