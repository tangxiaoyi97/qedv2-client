import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/** Decorative loading motion runs only while its surface can be seen. */
export function useVisibleMotion(element: Ref<HTMLElement | null>) {
  const visible = ref(true);
  let observer: IntersectionObserver | undefined;
  onMounted(() => {
    if (!element.value || typeof IntersectionObserver !== 'function') return;
    observer = new IntersectionObserver(([entry]) => {
      visible.value = entry?.isIntersecting ?? true;
    });
    observer.observe(element.value);
  });
  onBeforeUnmount(() => observer?.disconnect());
  return visible;
}
