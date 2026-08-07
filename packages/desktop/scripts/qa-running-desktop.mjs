#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function option(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const port = Number(option('port', '9223'));
const outputDirectory = resolve(option('output', '/private/tmp/qed2-desktop-qa'));
assert(Number.isInteger(port) && port > 0 && port <= 65_535, 'Invalid DevTools port');

const devtoolsOrigin = `http://127.0.0.1:${port}`;

async function readJson(pathname) {
  const response = await fetch(`${devtoolsOrigin}${pathname}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert(response.ok, `DevTools request failed: ${response.status}`);
  return await response.json();
}

class CdpClient {
  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolveConnection, rejectConnection) => {
      const timer = setTimeout(() => rejectConnection(new Error('DevTools connection timed out')), 5_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolveConnection();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        rejectConnection(new Error('DevTools connection failed'));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string'
        ? event.data
        : Buffer.from(event.data).toString('utf8');
      const message = JSON.parse(raw);
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`DevTools method timed out: ${method}`));
      }, 8_000);
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? 'Renderer evaluation failed');
    }
    return response.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function pageTargets() {
  const targets = await readJson('/json/list');
  return targets.filter((target) => target.type === 'page');
}

async function waitFor(description, probe, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function targetFor(targets, predicate) {
  return targets.find((target) => predicate(new URL(target.url)));
}

function isDesktopToolRoute(url, target) {
  return url.pathname === `/desktop/${target}`;
}

async function capture(client, name) {
  await client.call('Page.enable');
  const screenshot = await client.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const destination = resolve(outputDirectory, `${name}.png`);
  await writeFile(destination, Buffer.from(screenshot.data, 'base64'));
  return destination;
}

await mkdir(outputDirectory, { recursive: true });

const initialTargets = await waitFor('main desktop target', async () => {
  const targets = await pageTargets();
  const main = targetFor(
    targets,
    (url) =>
      url.pathname !== '/practice' &&
      !isDesktopToolRoute(url, 'updates') &&
      !isDesktopToolRoute(url, 'node'),
  );
  return main ? { targets, main } : undefined;
});

const main = await CdpClient.connect(initialTargets.main.webSocketDebuggerUrl);
const initial = await waitFor('main renderer shell', async () => {
  const state = await main.evaluate(`(async () => ({
    platform: document.querySelector('.app')?.dataset.platform,
    desktopEntry: Boolean(document.querySelector('[data-desktop-capability-entry]')),
    manifest: Boolean(document.querySelector('link[rel="manifest"]')),
    serviceWorkers: 'serviceWorker' in navigator
      ? (await navigator.serviceWorker.getRegistrations()).length
      : 0,
    floatingBeacon: Boolean(document.querySelector(
      '[data-desktop-beacon], .qed2-desktop-beacon, #qed2-platform-root > *'
    )),
  }))()`);
  return state.platform ? state : undefined;
}, 20_000);
assert.equal(initial.platform, 'desktop');
assert.equal(initial.desktopEntry, true);
assert.equal(initial.manifest, false);
assert.equal(initial.serviceWorkers, 0);
assert.equal(initial.floatingBeacon, false);

await main.evaluate(`document.querySelector('[data-desktop-capability-entry]')?.click()`);
await waitFor('desktop control centre', async () => {
  const state = await main.evaluate(`({
    path: location.pathname,
    controlCenter: Boolean(document.querySelector('[data-desktop-control-center]')),
    buttons: document.querySelectorAll('[data-desktop-window-target]').length,
  })`);
  return state.path === '/desktop' && state.controlCenter && state.buttons === 3;
});

const mainLayout = await main.evaluate(`({
  heading: document.querySelector('#desktop-title')?.textContent?.trim(),
  actionHeights: [...document.querySelectorAll('#desktop .q-btn')]
    .map((button) => Number.parseFloat(getComputedStyle(button).height)),
  progressLabels: [...document.querySelectorAll('#desktop progress')]
    .map((progress) => progress.getAttribute('aria-label')),
})`);
assert.equal(mainLayout.heading, 'Desktop & lokaler Knoten');
assert(mainLayout.actionHeights.every((height) => height >= 44), 'Desktop controls must be at least 44px');
assert(mainLayout.progressLabels.every(Boolean), 'Every visible progress bar needs an accessible name');

const opened = {};
for (const target of ['practice', 'updates', 'node']) {
  await main.evaluate(`document.querySelector('[data-desktop-window-target="${target}"]')?.click()`);
  const nativeTarget = await waitFor(`${target} native window`, async () => {
    const targets = await pageTargets();
    if (target === 'practice') {
      return targetFor(targets, (url) => url.pathname === '/practice');
    }
    return targetFor(targets, (url) => isDesktopToolRoute(url, target));
  });
  opened[target] = nativeTarget;

  await main.evaluate(`document.querySelector('[data-desktop-window-target="${target}"]')?.click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const duplicates = (await pageTargets()).filter((candidate) => {
    const url = new URL(candidate.url);
    return target === 'practice'
      ? url.pathname === '/practice'
      : isDesktopToolRoute(url, target);
  });
  assert.equal(duplicates.length, 1, `${target} must remain a singleton`);
  assert.equal(duplicates[0].id, nativeTarget.id, `${target} singleton identity changed`);
}

const screenshots = [await capture(main, 'main-desktop-settings')];
const toolChecks = {};
for (const target of ['updates', 'node']) {
  const client = await CdpClient.connect(opened[target].webSocketDebuggerUrl);
  const expectedTitle = target === 'updates' ? 'Aktualisierungen' : 'Lokaler Knoten';
  const state = await waitFor(`${target} tool UI`, async () => {
    const value = await client.evaluate(`({
      title: document.querySelector('h1')?.textContent?.trim(),
      titleSize: Number.parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),
      chromeHidden: document.querySelector('.app__sidebar')?.classList.contains('app__sidebar--hidden'),
      embeddedWindowButtons: document.querySelectorAll('[data-desktop-window-target]').length,
      actionHeights: [...document.querySelectorAll('#desktop .q-btn')]
        .map((button) => Number.parseFloat(getComputedStyle(button).height)),
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight,
    })`);
    return value.title === expectedTitle ? value : undefined;
  });
  assert(state.titleSize >= 22, `${target} H1 must use the page-title scale`);
  assert.equal(state.chromeHidden, true);
  assert.equal(state.embeddedWindowButtons, 0);
  assert(state.actionHeights.every((height) => height >= 44), `${target} controls must be at least 44px`);
  if (target === 'node') {
    assert(state.scrollHeight <= state.innerHeight + 1, 'Node tool window has avoidable viewport overflow');
  }
  toolChecks[target] = state;
  screenshots.push(await capture(client, target));
  client.close();
}

const practice = await CdpClient.connect(opened.practice.webSocketDebuggerUrl);
const practiceState = await waitFor('practice UI', async () => {
  const value = await practice.evaluate(`({
    visible: Boolean(document.querySelector('.practice')),
    closeSize: (() => {
      const button = document.querySelector('.practice__close');
      if (!button) return null;
      const style = getComputedStyle(button);
      return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
    })(),
  })`);
  return value.visible ? value : undefined;
});
if (practiceState.closeSize) {
  assert(practiceState.closeSize.width >= 44 && practiceState.closeSize.height >= 44,
    'Practice close control must have a 44px target');
}
screenshots.push(await capture(practice, 'practice'));
practice.close();

await main.evaluate(`
  document.querySelector('a[href="/settings"]')?.click();
  undefined
`);
await waitFor('the appearance settings', async () => {
  return await main.evaluate(`
    location.pathname === '/settings' &&
      Boolean(document.querySelector('[aria-label="Erscheinungsbild"] [role="radio"]'))
  `);
});
const activeThemeLabel = await main.evaluate(`
  document.querySelector('[aria-label="Erscheinungsbild"] [role="radio"][aria-checked="true"]')
    ?.textContent?.trim()
`);
assert(['Hell', 'Dunkel', 'System'].includes(activeThemeLabel), 'Could not identify the active theme');
await main.evaluate(`
  [...document.querySelectorAll('[aria-label="Erscheinungsbild"] [role="radio"]')]
    .find((button) => button.textContent?.trim() === 'Dunkel')?.click()
`);

const themedTargets = {
  main: initialTargets.main,
  practice: opened.practice,
  updates: opened.updates,
  node: opened.node,
};
for (const [name, target] of Object.entries(themedTargets)) {
  const client = name === 'main' ? main : await CdpClient.connect(target.webSocketDebuggerUrl);
  await waitFor(`${name} dark-theme propagation`, async () => {
    return await client.evaluate(`document.documentElement.dataset.theme === 'dark'`);
  });
  screenshots.push(await capture(client, `${name}-dark`));
  if (client !== main) client.close();
}

await main.evaluate(`
  [...document.querySelectorAll('[aria-label="Erscheinungsbild"] [role="radio"]')]
    .find((button) => button.textContent?.trim() === ${JSON.stringify(activeThemeLabel)})?.click()
`);
main.close();

console.log(JSON.stringify({
  ok: true,
  windows: {
    main: initialTargets.main.id,
    practice: opened.practice.id,
    updates: opened.updates.id,
    node: opened.node.id,
  },
  toolChecks,
  screenshots,
}, null, 2));
