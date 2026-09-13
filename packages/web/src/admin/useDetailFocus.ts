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
  async function restore() {
    await nextTick();
    if (disposed || !trigger?.isConnected) return;
    trigger.focus({ preventScroll: true });
    trigger.scrollIntoView?.({ behavior: 'auto', block: 'nearest' });
    trigger = null;
  }
  onBeforeUnmount(() => { disposed = true; trigger = null; });
  return { region, capture, reveal, restore };
}
