import 'fake-indexeddb/auto';
import { createApp, h, nextTick, type App as VueApp } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../src/App.vue';
import { ports } from '../src/services.js';

const originalShell = ports.shell;
let mounted: VueApp | undefined;
let pinia: Pinia | undefined;

afterEach(() => {
  mounted?.unmount();
  if (pinia) disposePinia(pinia);
  ports.shell = originalShell;
  document.body.replaceChildren();
});

describe('desktop tool-window navigation', () => {
  it('omits global chrome from both tools while preserving main-window tabs and focus animations', async () => {
    ports.shell = { ...originalShell, capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true } };
    pinia = createPinia();
    const page = { render: () => h('p', 'Page content') };
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: page },
      { path: '/desktop/node', component: page },
      { path: '/desktop/updates', component: page },
      { path: '/practice', component: page, meta: { focus: true } },
    ] });
    await router.push('/');
    const host = document.createElement('div');
    document.body.appendChild(host);
    mounted = createApp(App).use(pinia).use(router);
    mounted.mount(host);
    await nextTick();
    expect(host.querySelector('.app__tabbar')).not.toBeNull();
    expect(host.querySelector('.app__sidebar')).not.toBeNull();

    for (const route of ['/desktop/node', '/desktop/updates']) {
      await router.push(route); await nextTick();
      // No offscreen fixed navigation exists to overlap or enter full-page
      // captures at any viewport width; this does not depend on CSS transforms.
      expect(host.querySelector('.app__tabbar')).toBeNull();
      expect(host.querySelector('.app__sidebar')).toBeNull();
      expect(host.querySelector('.app__scrim')).toBeNull();
      expect(host.querySelector('.app__main--tool')).not.toBeNull();
    }

    await router.push('/'); await nextTick();
    expect(host.querySelector('.app__tabbar')).not.toBeNull();
    expect(host.querySelector('.app__tabbar--hidden')).toBeNull();
    expect(host.querySelector('.app__main--tool')).toBeNull();
    await router.push('/practice'); await nextTick();
    expect(host.querySelector('.app__tabbar--hidden')).not.toBeNull();
    expect(host.querySelector('.app__sidebar--hidden')).not.toBeNull();
    expect(host.querySelector('.app__main--tool')).toBeNull();
  });
});
