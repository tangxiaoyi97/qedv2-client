import { nextTick, onBeforeUnmount, shallowRef } from 'vue';

/** Move to freshly loaded details; retain the actual trigger before it is disabled. */
export function useDetailFocus() {
  const region = shallowRef<HTMLElement>();
  let trigger: HTMLElement | null = null;
  let disposed = false;
  function capture(event?: Event) {
    trigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  async function reveal() {
    await nextTick();
    if (disposed || !region.value?.isConnected) return;
    region.value.focus({ preventScroll: true });
    region.value.scrollIntoView?.({ behavior: 'auto', block: 'start' });
  }
  async function restore(fallback?: HTMLElement) {
    await nextTick();
    const target = trigger?.isConnected ? trigger : fallback;
    trigger = null;
    if (disposed || !target?.isConnected) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
  }
  onBeforeUnmount(() => { disposed = true; trigger = null; });
  return { region, capture, reveal, restore };
}
