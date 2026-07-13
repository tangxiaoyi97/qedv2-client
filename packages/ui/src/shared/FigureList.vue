<script setup lang="ts">
/** Render the schema's standalone Figure[] fields through the shell resolver. */
import { computed } from 'vue';
import type { Figure, ImageFigure } from '@qed2/core-logic';
import { useAssetResolver } from './assets.js';

const props = defineProps<{ figures?: Figure[] }>();
const resolveAsset = useAssetResolver();
const images = computed(() =>
  (props.figures ?? []).filter((figure): figure is ImageFigure => figure.kind === 'image'),
);
</script>

<template>
  <div v-if="images.length > 0" class="q-figures">
    <figure v-for="(figure, index) in images" :key="`${figure.src}-${index}`" class="q-figures__item">
      <img
        class="q-figures__image"
        :src="resolveAsset(figure.src)"
        :alt="figure.alt ?? ''"
        loading="lazy"
      />
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
.q-figures__image {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  background: #fff;
}
</style>
