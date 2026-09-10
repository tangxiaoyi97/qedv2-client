import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bodyScrollLockDepth,
  lockBodyScroll,
  unlockBodyScroll,
} from '../src/shared/scroll-lock.js';

/** jsdom has no layout, so scrollY is stubbed to stand in for a scrolled page. */
function scrolledTo(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

describe('body scroll lock', () => {
  beforeEach(() => {
    scrolledTo(0);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(() => {
    while (bodyScrollLockDepth() > 0) unlockBodyScroll();
    document.body.className = '';
    document.body.style.top = '';
    document.documentElement.style.removeProperty('scrollbar-gutter');
    vi.restoreAllMocks();
  });

  it('pins the body out of flow rather than relying on overflow alone', () => {
    // The `overflow: hidden` lock is silently ignored by iOS Safari; taking the
    // body out of flow at a negative offset is what actually holds.
    scrolledTo(640);
    lockBodyScroll();

    expect(document.body.classList.contains('q-modal-open')).toBe(true);
    expect(document.body.style.top).toBe('-640px');
  });

  it('restores the exact scroll position on release', () => {
    scrolledTo(640);
    lockBodyScroll();
    unlockBodyScroll();

    expect(document.body.classList.contains('q-modal-open')).toBe(false);
    expect(document.body.style.top).toBe('');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it('keeps the lock while a nested overlay is still open', () => {
    scrolledTo(320);
    lockBodyScroll(); // drawer
    lockBodyScroll(); // dialog opened from inside it

    unlockBodyScroll();
    expect(document.body.classList.contains('q-modal-open')).toBe(true);
    expect(window.scrollTo).not.toHaveBeenCalled();

    unlockBodyScroll();
    expect(document.body.classList.contains('q-modal-open')).toBe(false);
    // The offset recorded by the FIRST lock is the one that gets restored —
    // an inner lock must not re-record a position the page no longer has.
    expect(window.scrollTo).toHaveBeenCalledWith(0, 320);
  });

  it('preserves an existing classic scrollbar gutter until the final release', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1265);
    scrolledTo(640);
    lockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('stable');

    // The fixed body has no document overflow. An inner dialog must not
    // overwrite the original gutter state with the already locked layout.
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1280);
    lockBodyScroll();
    unlockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('stable');
    unlockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 640);
  });

  it('restores a pre-existing inline gutter value and its priority', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1265);
    document.documentElement.style.setProperty('scrollbar-gutter', 'auto', 'important');
    lockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('stable');
    expect(document.documentElement.style.getPropertyPriority('scrollbar-gutter')).toBe('important');
    unlockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('auto');
    expect(document.documentElement.style.getPropertyPriority('scrollbar-gutter')).toBe('important');
  });

  it('keeps an existing two-sided stable gutter intact', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1265);
    document.documentElement.style.setProperty('scrollbar-gutter', 'stable both-edges');
    lockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('stable both-edges');
    unlockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('stable both-edges');
  });

  it('does not introduce a gutter on short pages or with overlay scrollbars', () => {
    lockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('');
    unlockBodyScroll();
    expect(document.documentElement.style.getPropertyValue('scrollbar-gutter')).toBe('');
  });

  it('does not scroll when the lock was taken at the top of the page', () => {
    lockBodyScroll();
    unlockBodyScroll();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('ignores an unbalanced release instead of going negative', () => {
    unlockBodyScroll();
    expect(bodyScrollLockDepth()).toBe(0);
    lockBodyScroll();
    expect(bodyScrollLockDepth()).toBe(1);
  });
});
