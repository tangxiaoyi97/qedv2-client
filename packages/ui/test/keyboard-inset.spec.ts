import { createApp, defineComponent, h } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardInset } from '../src/shared/useKeyboardInset.js';

const LAYOUT_HEIGHT = 800;

interface FakeViewport {
  height: number;
  offsetTop: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  emit: (type: string) => void;
}

function fakeVisualViewport(): FakeViewport {
  const listeners = new Map<string, Set<() => void>>();
  return {
    height: LAYOUT_HEIGHT,
    offsetTop: 0,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function mountWithInset(): () => void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup() {
        useKeyboardInset();
        return () => h('div');
      },
    }),
  );
  app.mount(host);
  return () => app.unmount();
}

function inset(): string {
  return document.documentElement.style.getPropertyValue('--q-keyboard-inset');
}

describe('useKeyboardInset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty('--q-keyboard-inset');
    document.body.innerHTML = '';
  });

  it('reports the part of the layout viewport the keyboard covers', () => {
    const viewport = fakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', LAYOUT_HEIGHT);
    const unmount = mountWithInset();

    expect(inset()).toBe('0px');

    // iOS: the layout viewport keeps its height, the visual one shrinks and
    // scrolls down to reveal the focused field.
    viewport.height = 460;
    viewport.offsetTop = 40;
    viewport.emit('resize');
    expect(inset()).toBe('300px');

    viewport.height = LAYOUT_HEIGHT;
    viewport.offsetTop = 0;
    viewport.emit('resize');
    expect(inset()).toBe('0px');
    unmount();
  });

  it('ignores gaps too small to be a keyboard', () => {
    const viewport = fakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', LAYOUT_HEIGHT);
    const unmount = mountWithInset();

    // A collapsing URL bar must not translate the practice bar.
    viewport.height = LAYOUT_HEIGHT - 56;
    viewport.emit('resize');
    expect(inset()).toBe('0px');
    unmount();
  });

  it('drops the variable on unmount and no-ops without VisualViewport', () => {
    const viewport = fakeVisualViewport();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', LAYOUT_HEIGHT);
    mountWithInset()();
    expect(inset()).toBe('');

    // Old engines / jsdom: consumers fall back to the 0px default in CSS.
    vi.stubGlobal('visualViewport', undefined);
    const unmount = mountWithInset();
    expect(inset()).toBe('');
    unmount();
  });
});
