<script setup lang="ts">
/**
 * "Lösung" accordion (prototype 1d): official solution steps/alternatives.
 * Each SolutionEntry renders its RichText result, an optional grader note as
 * a subtle mono annotation ("Beurteilungshinweis") and any image figures.
 */
import { computed } from 'vue';
import type { SolutionEntry, ImageFigure } from '@qed2/core-logic';
import CollapsePanel from '../shared/CollapsePanel.vue';
import RichTextView from '../shared/RichTextView.vue';
import { useAssetResolver } from '../shared/assets.js';

const props = withDefaults(
  defineProps<{
    solution: SolutionEntry[] | undefined;
    defaultOpen?: boolean;
  }>(),
  { defaultOpen: true },
);

const resolveAsset = useAssetResolver();

const entries = computed(() => props.solution ?? []);

function imageFigures(entry: SolutionEntry): ImageFigure[] {
  return (entry.figures ?? []).filter((f): f is ImageFigure => f.kind === 'image');
}
</script>

<template>
  <CollapsePanel
    v-if="entries.length > 0"
    class="q-solution"
    title="Lösung"
    subtitle="Offizieller Lösungsweg"
    :default-open="defaultOpen"
  >
    <div class="q-solution__body">
      <template v-for="(entry, i) in entries" :key="i">
        <div v-if="i > 0" class="q-solution__divider" role="separator">
          <span class="q-solution__divider-label">Alternative</span>
        </div>
        <div class="q-solution__entry">
          <RichTextView class="q-solution__result" :nodes="entry.result" />
          <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-solution__figure">
            <img
              class="q-solution__img"
              :src="resolveAsset(fig.src)"
              :alt="fig.alt ?? ''"
              loading="lazy"
            />
          </figure>
          <div v-if="entry.note" class="q-solution__note">
            <span class="q-solution__note-label">Beurteilungshinweis</span>
            <span class="q-solution__note-text">{{ entry.note }}</span>
          </div>
        </div>
      </template>
    </div>
  </CollapsePanel>
</template>

<style scoped>
.q-solution__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--q-ink-2);
}
.q-solution__result {
  overflow-wrap: break-word;
}
.q-solution__divider {
  display: flex;
  align-items: center;
  gap: 10px;
}
.q-solution__divider::before,
.q-solution__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--q-border-2);
}
.q-solution__divider-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-solution__entry {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.q-solution__figure {
  margin: 0;
}
.q-solution__img {
  max-width: 100%;
  border: 1px solid var(--q-border);
  border-radius: 10px;
  display: block;
  margin: 0 auto;
  background: #fff;
}
.q-solution__note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
}
.q-solution__note-label {
  font: 700 10px ui-monospace, Menlo, monospace;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-solution__note-text {
  font: 500 11.5px/1.6 ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  overflow-wrap: break-word;
}
</style>
