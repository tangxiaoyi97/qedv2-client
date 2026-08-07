import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ShellPort } from '@qed2/core-logic';
import {
  desktopCapabilityRedirect,
  legacyDesktopSettingsRedirect,
} from '../src/router.js';
import { ports } from '../src/services.js';

const originalShell = ports.shell;
const PASSTHROUGH = { template: '<div />' };

function useDesktopShell(): void {
  ports.shell = {
    capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
    onCommand: () => () => undefined,
  } satisfies ShellPort;
}

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/settings',
        name: 'settings',
        component: PASSTHROUGH,
        beforeEnter: (to) => legacyDesktopSettingsRedirect(to.query),
      },
      {
        path: '/desktop',
        name: 'desktop',
        component: PASSTHROUGH,
        beforeEnter: desktopCapabilityRedirect,
      },
      {
        path: '/desktop/updates',
        name: 'desktop-updates',
        component: PASSTHROUGH,
        beforeEnter: desktopCapabilityRedirect,
      },
      {
        path: '/desktop/node',
        name: 'desktop-node',
        component: PASSTHROUGH,
        beforeEnter: desktopCapabilityRedirect,
      },
    ],
  });
}

afterEach(() => {
  ports.shell = originalShell;
});

describe('capability-gated Desktop routing', () => {
  it('redirects a Web/PWA deep link before the Desktop route is entered', async () => {
    const router = createTestRouter();

    await router.push('/desktop');

    expect(router.currentRoute.value.fullPath).toBe('/settings');
    expect(router.currentRoute.value.name).toBe('settings');
  });

  it('admits the independent control centre only for a Desktop shell', async () => {
    useDesktopShell();
    const router = createTestRouter();

    await router.push('/desktop');

    expect(router.currentRoute.value.fullPath).toBe('/desktop');
    expect(router.currentRoute.value.name).toBe('desktop');
  });

  it('migrates every old embedded route to its dedicated Desktop surface', async () => {
    useDesktopShell();

    const main = createTestRouter();
    await main.push('/settings?section=desktop');
    expect(main.currentRoute.value.fullPath).toBe('/desktop');

    for (const desktopWindow of ['updates', 'node'] as const) {
      const tool = createTestRouter();
      await tool.push(`/settings?section=desktop&desktopWindow=${desktopWindow}`);
      expect(tool.currentRoute.value.fullPath).toBe(`/desktop/${desktopWindow}`);
    }
  });

  it('keeps every dedicated Desktop surface out of Web/PWA', async () => {
    for (const path of ['/desktop', '/desktop/updates', '/desktop/node']) {
      const web = createTestRouter();
      await web.push(path);
      expect(web.currentRoute.value.fullPath).toBe('/settings');
    }
  });

  it('strips Desktop query surfaces from Web and rejects malformed tool-window queries', async () => {
    const web = createTestRouter();
    await web.push('/settings?section=desktop&desktopWindow=node');
    expect(web.currentRoute.value.fullPath).toBe('/settings');

    useDesktopShell();
    for (const path of [
      '/settings?desktopWindow=node',
      '/settings?section=desktop&desktopWindow=other',
    ]) {
      const malformed = createTestRouter();
      await malformed.push(path);
      expect(malformed.currentRoute.value.fullPath).toBe('/settings');
    }
  });
});
