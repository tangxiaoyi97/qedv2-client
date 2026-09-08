<script setup lang="ts">
import { useI18n } from '../i18n.js';
import { ref } from 'vue';
import { useVisibleMotion } from './useVisibleMotion.js';

const { t } = useI18n();
const surface = ref<HTMLElement | null>(null);
const motionVisible = useVisibleMotion(surface);
/**
 * Page-level loading state: one centred panel for a whole section that has
 * nothing to show yet and no row shape worth faking.
 *
 * Same shimmer surface as QSkeleton (styles/tokens.css `.q-skeleton`), tuned
 * for the larger scale — a slim bar over a label rather than a list of rows,
 * so the two never look like different products.
 */
withDefaults(
  defineProps<{
    label?: string;
    /** Drop the surrounding card when the caller already draws one. */
    bare?: boolean;
  }>(),
  { label: 'Wird geladen …', bare: false },
);
</script>

<template>
  <div ref="surface" class="q-loadpanel" :class="{ 'q-loadpanel--bare': bare, 'q-loadpanel--paused': !motionVisible }" role="status">
    <div class="q-skeleton q-loadpanel__bar" aria-hidden="true" />
    <span class="q-loadpanel__label">{{ t(label) }}</span>
  </div>
</template>

<style scoped>
.q-loadpanel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 20px;
  border: 1px solid var(--q-border);
  border-radius: 11px;
  background: var(--q-card);
}
.q-loadpanel--bare {
  border: none;
  background: none;
  padding: 32px 0;
}
.q-loadpanel--paused .q-skeleton::after { animation-play-state: paused; }
.q-loadpanel__bar {
  width: min(220px, 60%);
  height: 5px;
  border-radius: 3px;
}
.q-loadpanel__label {
  font-size: 13px;
  color: var(--q-mut);
}
</style>
