<script setup lang="ts">
/**
 * One mastery row (prototype 3a "Beherrschung" card): code · track/fill bar ·
 * level text label (hoch / mittel / gering) — never color-only.
 */
import { computed } from 'vue';
import { masteryLevel } from '@qed2/core-logic';

const props = defineProps<{
  code: string;
  /** 0..1 */
  mastery: number;
  level?: 'low' | 'medium' | 'high';
}>();

const LEVEL_LABELS = { low: 'gering', medium: 'mittel', high: 'hoch' } as const;

const level = computed(() => props.level ?? masteryLevel(props.mastery));
const label = computed(() => LEVEL_LABELS[level.value]);
const percent = computed(() => Math.round(Math.min(1, Math.max(0, props.mastery)) * 100));
</script>

<template>
  <div
    class="q-mastery"
    role="img"
    :aria-label="`${code}: ${percent} % · ${label}`"
  >
    <span class="q-mastery__code">{{ code }}</span>
    <span class="q-mastery__track">
      <span
        class="q-mastery__fill"
        :class="`q-mastery__fill--${level}`"
        :style="{ width: `${percent}%` }"
      />
    </span>
    <span class="q-mastery__label" :class="`q-mastery__label--${level}`">{{ label }}</span>
  </div>
</template>

<style scoped>
.q-mastery {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.q-mastery__code {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-accent-strong);
  flex: none;
  min-width: 26px;
}
.q-mastery__track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--q-track);
  overflow: hidden;
  display: block;
}
.q-mastery__fill {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.q-mastery__fill--high {
  background: var(--q-ok);
}
.q-mastery__fill--medium {
  background: var(--q-part);
}
.q-mastery__fill--low {
  /* red, not grey: low mastery means „needs attention", grey reads as
   * „no data / inactive" */
  background: var(--q-err);
}
.q-mastery__label {
  flex: none;
  width: 44px;
  text-align: right;
  font-size: 11px;
  font-weight: 700;
}
.q-mastery__label--high {
  color: var(--q-ok);
}
.q-mastery__label--medium {
  color: var(--q-part-ink);
}
.q-mastery__label--low {
  color: var(--q-err);
}
</style>
