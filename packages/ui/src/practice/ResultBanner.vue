<script setup lang="ts">
/**
 * Grade feedback banner (prototype 1d + "Zustände" note): three variants by
 * verdict — never color-only, always StateIcon + text label + points.
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

/** German decimal comma for halves: 0.5 → "0,5". */
function fmt(n: number): string {
  return String(n).replace('.', ',');
}

const points = computed(() => `${fmt(props.result.awardedPoints)} / ${fmt(props.result.maxPoints)}`);
</script>

<template>
  <div class="q-result-banner" :class="`q-result-banner--${verdict}`" role="status">
    <StateIcon :state="verdict" :size="38" />
    <div class="q-result-banner__text">
      <div class="q-result-banner__label">{{ label }}</div>
      <div class="q-result-banner__sub"><slot /></div>
    </div>
    <div class="q-result-banner__points">
      <div class="q-result-banner__score">{{ points }}</div>
      <div class="q-result-banner__unit">Punkte</div>
    </div>
  </div>
</template>

<style scoped>
.q-result-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  border-radius: 12px;
  border: 1px solid;
}
.q-result-banner--correct {
  background: var(--q-ok-bg);
  border-color: var(--q-ok-border);
  color: var(--q-ok-ink);
}
.q-result-banner--partial {
  background: var(--q-part-bg);
  border-color: var(--q-part-border);
  color: var(--q-part-ink);
}
.q-result-banner--incorrect {
  background: var(--q-err-bg);
  border-color: var(--q-err-border);
  color: var(--q-err-ink);
}
.q-result-banner__text {
  min-width: 0;
}
.q-result-banner__label {
  font-weight: 700;
  font-size: 15px;
}
.q-result-banner__sub {
  font-size: 12.5px;
  opacity: 0.88;
  overflow-wrap: break-word;
}
.q-result-banner__sub:empty {
  display: none;
}
.q-result-banner__points {
  margin-left: auto;
  text-align: right;
  flex: none;
}
.q-result-banner__score {
  font-weight: 800;
  font-size: 20px;
}
.q-result-banner__unit {
  font-size: 11px;
  opacity: 0.88;
}
</style>
