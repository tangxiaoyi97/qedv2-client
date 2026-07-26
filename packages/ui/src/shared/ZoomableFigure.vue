<script setup lang="ts">
/**
 * A figure image that can be opened full screen and zoomed.
 *
 * Owns the image presentation (the border/radius/white plate that FigureList
 * and SolutionSheet used to declare separately) so both call sites get the
 * same affordance from one element, and mounts FigureViewer on demand — the
 * gesture code and the body scroll lock only exist while a figure is open.
 */
import { ref } from 'vue';
import { Maximize2 } from 'lucide-vue-next';
import FigureViewer from './FigureViewer.vue';

const props = defineProps<{
  src: string;
  alt?: string;
}>();

const open = ref(false);
</script>

<template>
  <button
    type="button"
    class="q-zfig"
    :aria-label="props.alt ? `${props.alt} — vergrößern` : 'Abbildung vergrößern'"
    @click="open = true"
  >
    <img class="q-zfig__img" :src="props.src" :alt="props.alt ?? ''" loading="lazy" />
    <span class="q-zfig__badge" aria-hidden="true">
      <Maximize2 :size="14" :stroke-width="2.4" />
    </span>
  </button>
  <FigureViewer v-if="open" :src="props.src" :alt="props.alt" @close="open = false" />
</template>

<style scoped>
.q-zfig {
  position: relative;
  display: block;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto;
  padding: 0;
  border: none;
  background: none;
  cursor: zoom-in;
  line-height: 0;
}

.q-zfig__img {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: #fff;
}

/* Without this the image looks like plain content and nobody discovers the
 * zoom — which is the whole reason the component exists. */
.q-zfig__badge {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--q-border-2);
  background: var(--q-card);
  color: var(--q-mut-2);
  opacity: 0.9;
  transition: opacity var(--q-transition-fast), color var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .q-zfig:hover .q-zfig__badge {
    opacity: 1;
    color: var(--q-accent-strong);
  }
}
@media (pointer: coarse) {
  .q-zfig__badge {
    width: 34px;
    height: 34px;
  }
}
</style>
