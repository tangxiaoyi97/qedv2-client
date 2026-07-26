<script setup lang="ts">
/** Render the schema's standalone Figure[] fields through the shell resolver. */
import { computed } from 'vue';
import type { Figure, ImageFigure } from '@qed2/core-logic';
import { useAssetResolver } from './assets.js';
import ZoomableFigure from './ZoomableFigure.vue';

const props = defineProps<{ figures?: Figure[] }>();
const resolveAsset = useAssetResolver();
const images = computed(() =>
  (props.figures ?? []).filter((figure): figure is ImageFigure => figure.kind === 'image'),
);
</script>

<template>
  <div v-if="images.length > 0" class="q-figures">
    <figure v-for="(figure, index) in images" :key="`${figure.src}-${index}`" class="q-figures__item">
      <ZoomableFigure :src="resolveAsset(figure.src)" :alt="figure.alt" />
    </figure>
  </div>
</template>

<style scoped>
.q-figures {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 14px 0;
}
.q-figures__item {
  margin: 0;
}
/* The image plate itself now lives in ZoomableFigure, so the thumbnail and
 * its zoom affordance stay identical everywhere figures are rendered. */
</style>
