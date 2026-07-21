/**
 * useModalA11y — one accessibility baseline for every overlay in the app:
 *
 *  - Tab / Shift+Tab cycle INSIDE the dialog (focus trap);
 *  - Escape closes (document-level, so it works no matter where focus is);
 *  - the page behind the backdrop stops scrolling (body.q-modal-open);
 *  - focus moves into the dialog on open and returns to the previously
 *    focused element on close.
 *
 * Usage:
 *   const box = ref<HTMLElement | null>(null);
 *   useModalA11y(box, isOpenRef, close);
 *   // template: <div ref="box" role="dialog" aria-modal="true" …>
 *
 * The composable listens on `document` in the capture phase, so nested
 * overlays stack correctly: the topmost open dialog (last watcher armed)
 * handles the event first and stops propagation for the ones below.
 */
import { onBeforeUnmount, watch, type Ref } from 'vue';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

let openCount = 0;

function lockScroll(): void {
  openCount += 1;
  document.body.classList.add('q-modal-open');
}
function unlockScroll(): void {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) document.body.classList.remove('q-modal-open');
}

export function useModalA11y(
  container: Ref<HTMLElement | null>,
  isOpen: Ref<boolean>,
  onClose: () => void,
): void {
  let previousFocus: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    if (!container.value) return [];
    return Array.from(container.value.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (!isOpen.value) return;
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      ev.preventDefault();
      onClose();
      return;
    }
    if (ev.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) {
      ev.preventDefault();
      container.value?.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const inside = active != null && (container.value?.contains(active) ?? false);
    const idx = inside ? items.indexOf(active) : -1;
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

  watch(
    isOpen,
    (open, wasOpen) => {
      if (open === wasOpen) return;
      if (open) {
        previousFocus = document.activeElement as HTMLElement | null;
        lockScroll();
        document.addEventListener('keydown', onKeydown, true);
        requestAnimationFrame(() => {
          // Prefer an explicitly marked field, else the first focusable,
          // else the dialog container itself.
          const target =
            container.value?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? null;
          (target ?? container.value)?.focus({ preventScroll: true });
        });
      } else {
        unlockScroll();
        document.removeEventListener('keydown', onKeydown, true);
        previousFocus?.focus({ preventScroll: true });
        previousFocus = null;
      }
    },
    { flush: 'post', immediate: true },
  );

  onBeforeUnmount(() => {
    if (isOpen.value) {
      unlockScroll();
      previousFocus?.focus({ preventScroll: true });
    }
    document.removeEventListener('keydown', onKeydown, true);
  });
}
