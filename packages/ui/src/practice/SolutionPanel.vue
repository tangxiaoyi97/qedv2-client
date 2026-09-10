<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * "Lösung" accordion (prototype 1d): official solution steps/alternatives.
 * Each alternative renders steps, result, short alternatives and figures.
 * All fields are optional because historical Bank rows may be steps-only or
 * figure-only.
 */
import { computed } from 'vue';
import { isRichTextEmpty, type SolutionEntry, type ImageFigure } from '@qed2/core-logic';
import CollapsePanel from '../shared/CollapsePanel.vue';
import RichTextView from '../shared/RichTextView.vue';
import ZoomableFigure from '../shared/ZoomableFigure.vue';
import { useAssetResolver } from '../shared/assets.js';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    solution: SolutionEntry[] | undefined;
    defaultOpen?: boolean;
    /** Render inside a clearly labelled review page without an accordion. */
    plain?: boolean;
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
  <component
    :is="plain ? 'div' : CollapsePanel"
    v-if="entries.length > 0"
    class="q-solution"
    :class="{ 'q-solution--plain': plain }"
    :title="t('Lösung')"
    :default-open="defaultOpen"
  >
    <div class="q-solution__body">
      <template v-for="(entry, i) in entries" :key="i">
        <div v-if="i > 0" class="q-solution__divider" role="separator">
          <span class="q-solution__divider-label">{{ t('Alternative') }}</span>
        </div>
        <div class="q-solution__entry">
          <RichTextView
            v-if="!isRichTextEmpty(entry.steps)"
            class="q-solution__steps"
            :nodes="entry.steps"
          />
          <RichTextView
            v-if="!isRichTextEmpty(entry.result)"
            class="q-solution__result"
            :nodes="entry.result"
          />
          <div
            v-for="(alternative, ai) in entry.alternatives ?? []"
            :key="`${entry.id ?? i}-alternative-${ai}`"
            class="q-solution__alternative"
          >
            <span class="q-solution__alternative-label">{{ t('Alternative') }}</span>
            <RichTextView :nodes="alternative" />
          </div>
          <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-solution__figure">
            <ZoomableFigure :src="resolveAsset(fig.src)" :alt="fig.alt" />
          </figure>
          <div v-if="entry.note" class="q-solution__note">
            <span class="q-solution__note-label">{{ t('Beurteilungshinweis') }}</span>
            <span class="q-solution__note-text">{{ entry.note }}</span>
          </div>
        </div>
      </template>
    </div>
  </component>
</template>

<style scoped>
.q-solution--plain .q-solution__note {
  padding: 4px 0 4px 12px;
  border: none;
  border-left: 2px solid var(--q-border-2);
  border-radius: 0;
  background: none;
}
.q-solution--plain .q-solution__note-label { font-family: inherit; text-transform: none; letter-spacing: 0; }
.q-solution--plain .q-solution__note-text { font-family: inherit; font-size: 12px; }

.q-solution__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--q-ink-2);
}
.q-solution__result {
  font-weight: 650;
  color: var(--q-ink);
  overflow-wrap: break-word;
}
.q-solution__steps {
  overflow-wrap: break-word;
}
.q-solution__alternative {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
  border-left: 2px solid var(--q-border-2);
}
.q-solution__alternative-label {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--q-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
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
/* Image plate + zoom affordance come from ZoomableFigure. */
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
