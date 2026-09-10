/**
 * Body scroll lock shared by every overlay in the app.
 *
 * `body { overflow: hidden }` is the usual trick and it does NOT work on iOS
 * Safari — the page happily keeps scrolling behind the backdrop, and once the
 * overlay closes the reader is somewhere else entirely. The only lock that
 * holds there is pinning the body out of flow and shifting it up by the
 * current scroll offset, then restoring that offset on release.
 *
 * The counter makes nesting safe (a dialog opened from a drawer): only the
 * first lock records the scroll position, only the last release restores it.
 * The visual half of the lock is `body.q-modal-open` in styles/tokens.css.
 */

const LOCK_CLASS = 'q-modal-open';
const GUTTER_PROPERTY = 'scrollbar-gutter';

let openCount = 0;
let savedScrollY = 0;
let savedGutter: { value: string; priority: string } | null = null;

export function lockBodyScroll(): void {
  openCount += 1;
  if (openCount > 1) return;
  savedScrollY = window.scrollY;
  const root = document.documentElement;
  // Pinning the body removes the document scrollbar. Reserve its existing
  // gutter so both normal content and viewport-fixed bars keep their width.
  // Short pages and overlay scrollbars need no new space; an existing stable
  // (possibly two-sided) gutter already handles this without an override.
  if (window.innerWidth > root.clientWidth
    && !getComputedStyle(root).getPropertyValue(GUTTER_PROPERTY).includes('stable')) {
    savedGutter = {
      value: root.style.getPropertyValue(GUTTER_PROPERTY),
      priority: root.style.getPropertyPriority(GUTTER_PROPERTY),
    };
    root.style.setProperty(GUTTER_PROPERTY, 'stable', savedGutter.priority);
  }
  document.body.style.top = `-${savedScrollY}px`;
  document.body.classList.add(LOCK_CLASS);
}

export function unlockBodyScroll(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount > 0) return;
  document.body.classList.remove(LOCK_CLASS);
  document.body.style.top = '';
  if (savedGutter) {
    if (savedGutter.value) {
      document.documentElement.style.setProperty(GUTTER_PROPERTY, savedGutter.value, savedGutter.priority);
    } else {
      document.documentElement.style.removeProperty(GUTTER_PROPERTY);
    }
    savedGutter = null;
  }
  // Instant, not smooth: the reader must land exactly where they left off,
  // and a smooth scroll here reads as the page drifting after the close.
  // A lock taken at the very top moved nothing, so there is nothing to undo.
  if (savedScrollY !== 0) window.scrollTo(0, savedScrollY);
}

/** Test seam — the counter is module state shared by every overlay. */
export function bodyScrollLockDepth(): number {
  return openCount;
}
