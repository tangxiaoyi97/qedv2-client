/**
 * useModalA11y — one accessibility baseline for every overlay in the app:
 *
 *  - Tab / Shift+Tab cycle INSIDE the dialog (focus trap);
 *  - Escape closes (document-level, so it works no matter where focus is);
 *  - the page behind the backdrop stops scrolling (shared/scroll-lock.ts,
 *    which is iOS-safe — plain `overflow: hidden` is not);
 *  - focus moves into the dialog on open and returns to the previously
 *    focused element on close.
 *
 * Usage:
 *   const box = ref<HTMLElement | null>(null);
 *   useModalA11y(box, isOpenRef, close);
 *   // template: <div ref="box" role="dialog" aria-modal="true" …>
 *
 * An explicit stack gives only the most recently opened dialog keyboard
 * control. Capture listeners themselves run in registration order, so they
 * cannot establish the order of nested overlays.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';
// Shared with @qed2/ui's own overlays (FigureViewer), so nesting a viewer
// inside a dialog keeps one consistent lock count.
import { lockBodyScroll, unlockBodyScroll } from './scroll-lock.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

interface ModalEntry {
  container: Ref<HTMLElement | null>;
  previousFocus: HTMLElement | null;
  parent: ModalEntry | null;
  focusInitial: () => void;
}

const openModals: ModalEntry[] = [];
function topModal(): ModalEntry | undefined { return openModals.at(-1); }

export function useModalA11y(
  container: Ref<HTMLElement | null>,
  isOpen: Ref<boolean>,
  onClose: () => void,
): void {
  let active = false;
  let focusFrame: number | null = null;
  const entry: ModalEntry = { container, previousFocus: null, parent: null, focusInitial };

  function focusables(): HTMLElement[] {
    if (!container.value) return [];
    return Array.from(container.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  function focusInitial(): void {
    if (!active || !isOpen.value || topModal() !== entry) return;
    const target =
      container.value?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? container.value;
    target?.focus({ preventScroll: true });
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (!active || !isOpen.value || topModal() !== entry) return;
    if (ev.key === 'Escape') {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      onClose();
      return;
    }
    if (ev.key !== 'Tab') return;
    ev.stopImmediatePropagation();
    const items = focusables();
    if (items.length === 0) {
      ev.preventDefault();
      container.value?.focus();
      return;
    }
    const focused = document.activeElement as HTMLElement | null;
    const inside = focused != null && (container.value?.contains(focused) ?? false);
    const idx = inside ? items.indexOf(focused) : -1;
    if (ev.shiftKey) {
      if (idx <= 0) {
        ev.preventDefault();
        items[items.length - 1]?.focus();
      }
    } else if (idx === -1 || idx === items.length - 1) {
      ev.preventDefault();
      items[0]?.focus();
    }
  }

  function deactivate(): void {
    // A closed-but-mounted dialog never owns a scroll lock. Likewise, its
    // close watcher and later unmount must not release the same lock twice.
    if (!active) return;
    active = false;
    if (focusFrame !== null) cancelAnimationFrame(focusFrame);
    focusFrame = null;
    const wasTop = topModal() === entry;
    const index = openModals.indexOf(entry);
    if (index !== -1) openModals.splice(index, 1);
    // If a parent disappears first, preserve the eventual return point for
    // its child without taking focus away from that child now.
    for (const modal of openModals) {
      if (modal.parent === entry) {
        modal.parent = entry.parent;
        modal.previousFocus = entry.previousFocus;
      }
    }
    document.removeEventListener('keydown', onKeydown, true);
    unlockBodyScroll();
    const previousFocus = entry.previousFocus;
    entry.previousFocus = null;
    entry.parent = null;
    if (!wasTop) return;
    const next = topModal();
    if (previousFocus?.isConnected && (!next || next.container.value?.contains(previousFocus))) {
      previousFocus.focus({ preventScroll: true });
    } else {
      next?.focusInitial();
    }
  }

  watch(
    isOpen,
    (open, wasOpen) => {
      if (open === wasOpen) return;
      if (open) {
        if (active) return;
        active = true;
        entry.previousFocus = document.activeElement as HTMLElement | null;
        entry.parent = topModal() ?? null;
        openModals.push(entry);
        lockBodyScroll();
        document.addEventListener('keydown', onKeydown, true);
        focusFrame = requestAnimationFrame(() => {
          focusFrame = null;
          focusInitial();
        });
      } else {
        deactivate();
      }
    },
    { flush: 'post', immediate: true },
  );

  onBeforeUnmount(deactivate);
}
