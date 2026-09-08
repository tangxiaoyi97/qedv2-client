import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { suppressThemeTransitions } from '../src/platform/theme.js';

const originalDocument = document;

describe('theme transition lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete originalDocument.documentElement.dataset.themeSwitching;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    delete originalDocument.documentElement.dataset.themeSwitching;
  });

  it('restores transitions exactly 80 ms after a theme change', () => {
    suppressThemeTransitions();

    expect(originalDocument.documentElement.dataset.themeSwitching).toBe('');
    vi.advanceTimersByTime(79);
    expect(originalDocument.documentElement.dataset.themeSwitching).toBe('');
    vi.advanceTimersByTime(1);
    expect(originalDocument.documentElement.dataset.themeSwitching).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts the delay when another theme change happens before cleanup', () => {
    suppressThemeTransitions();
    vi.advanceTimersByTime(60);
    suppressThemeTransitions();

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(20);
    expect(originalDocument.documentElement.dataset.themeSwitching).toBe('');
    vi.advanceTimersByTime(59);
    expect(originalDocument.documentElement.dataset.themeSwitching).toBe('');
    vi.advanceTimersByTime(1);
    expect(originalDocument.documentElement.dataset.themeSwitching).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the initiating root even after the global document disappears', () => {
    suppressThemeTransitions();
    vi.stubGlobal('document', undefined);
    Reflect.deleteProperty(globalThis, 'document');

    expect(typeof document).toBe('undefined');
    expect(() => vi.advanceTimersByTime(80)).not.toThrow();
    expect(originalDocument.documentElement.dataset.themeSwitching).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not alter a replacement document while cleaning the initiating root', () => {
    suppressThemeTransitions();
    const replacement = originalDocument.implementation.createHTMLDocument('replacement');
    replacement.documentElement.dataset.themeSwitching = 'new-document';
    vi.stubGlobal('document', replacement);

    expect(() => vi.advanceTimersByTime(80)).not.toThrow();
    expect(originalDocument.documentElement.dataset.themeSwitching).toBeUndefined();
    expect(replacement.documentElement.dataset.themeSwitching).toBe('new-document');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not schedule cleanup when invoked without a document', () => {
    vi.stubGlobal('document', undefined);

    expect(() => suppressThemeTransitions()).not.toThrow();
    expect(originalDocument.documentElement.dataset.themeSwitching).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
