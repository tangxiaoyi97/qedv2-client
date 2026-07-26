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
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });

  afterEach(() => {
    while (bodyScrollLockDepth() > 0) unlockBodyScroll();
    document.body.className = '';
    document.body.style.top = '';
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
