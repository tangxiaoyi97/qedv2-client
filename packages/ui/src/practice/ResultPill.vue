<script setup lang="ts">
/**
 * Compact grade-feedback pill for the practice bottom bar — StateIcon +
 * verdict label + points, tinted per verdict (never color-only: icon shape
 * and text always accompany the tint).
 */
import { computed } from 'vue';
import type { GradeResult } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';

const props = defineProps<{
  result: GradeResult;
}>();

const LABELS: Record<GradeResult['verdict'], string> = {
  correct: 'Richtig',
  partial: 'Teilweise richtig',
  incorrect: 'Falsch',
};

const verdict = computed(() => props.result.verdict);
const label = computed(() => LABELS[verdict.value]);

/** German decimal comma: 0.5 → "0,5". */
function fmt(n: number): string {
  return n.toLocaleString('de-AT');
}

const points = computed(() => `${fmt(props.result.awardedPoints)} / ${fmt(props.result.maxPoints)}`);
</script>

<template>
  <div class="q-result-pill" :class="`q-result-pill--${verdict}`" role="status">
    <StateIcon :state="verdict" :size="24" />
    <span class="q-result-pill__label">{{ label }}</span>
    <span class="q-result-pill__divider" aria-hidden="true"></span>
    <span class="q-result-pill__points">{{ points }}</span>
    <span class="q-result-pill__unit">Punkte</span>
  </div>
</template>

<style scoped>
.q-result-pill {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 7px 14px 7px 9px;
  border-radius: 999px;
  border: 1px solid;
}
.q-result-pill--correct {
  background: var(--q-ok-bg);
  border-color: var(--q-ok-border);
  color: var(--q-ok-ink);
}
.q-result-pill--partial {
  background: var(--q-part-bg);
  border-color: var(--q-part-border);
  color: var(--q-part-ink);
}
.q-result-pill--incorrect {
  background: var(--q-err-bg);
  border-color: var(--q-err-border);
  color: var(--q-err-ink);
}
.q-result-pill__label {
  font-weight: 700;
  font-size: 13.5px;
  white-space: nowrap;
}
.q-result-pill__divider {
  width: 1px;
  height: 18px;
  background: currentColor;
  opacity: 0.35;
  flex: none;
}
.q-result-pill__points {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
  font-weight: 700;
  font-size: 13.5px;
  white-space: nowrap;
}
.q-result-pill__unit {
  font-size: 10.5px;
  opacity: 0.85;
}
</style>
