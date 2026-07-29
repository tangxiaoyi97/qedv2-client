/**
 * Publishes the on-screen keyboard's height as the `--q-keyboard-inset` CSS
 * variable on <html>, so fixed chrome can lift itself out of the way in pure
 * CSS: `bottom: var(--q-keyboard-inset, 0px)`.
 *
 * Why this is needed at all: Android/Chrome shrinks the LAYOUT viewport when
 * the keyboard opens, so `position: fixed; bottom: 0` lands above it by
 * itself and this composable correctly reports 0. iOS Safari shrinks only the
 * VISUAL viewport — the layout viewport keeps its full height, and fixed
 * chrome stays anchored underneath the keyboard where it cannot be reached.
 * In the practice flow that hides the primary action ("Prüfen") exactly when
 * the user has just finished typing an answer.
 *
 * Call once, from the app shell. VisualViewport is absent in jsdom and on old
 * engines; the variable then simply never gets set and the `0px` fallback in
 * each consumer applies.
 */
import { onBeforeUnmount, onMounted } from 'vue';

const CSS_VAR = '--q-keyboard-inset';
/** Below this the gap is browser chrome (URL bar), not a keyboard. */
const MIN_KEYBOARD_PX = 80;

export function useKeyboardInset(): void {
  const viewport = typeof window === 'undefined' ? undefined : window.visualViewport;
  if (!viewport) return;

  function update(): void {
    // Portion of the layout viewport the visual viewport no longer covers at
    // the bottom. offsetTop accounts for the visual viewport having been
    // scrolled down inside the layout viewport to reveal the focused field.
    const hidden = window.innerHeight - viewport!.height - viewport!.offsetTop;
    const inset = hidden > MIN_KEYBOARD_PX ? Math.round(hidden) : 0;
    document.documentElement.style.setProperty(CSS_VAR, `${inset}px`);
  }

  onMounted(() => {
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  });

  onBeforeUnmount(() => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    document.documentElement.style.removeProperty(CSS_VAR);
  });
}
