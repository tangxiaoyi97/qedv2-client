<script setup lang="ts">
/**
 * Grading state capsule (supplement §3) — QChip-look pill showing the
 * current mastery grading as GradingDot + German label. Tone by state:
 * good → ok tint, careless/meh/baffled → partial tint,
 * excluded/unseen → neutral tint. `interactive` renders a <button>
 * (hover ring + ▾) — used as the GradingMenu trigger.
 */
import { computed } from 'vue';
import type { GradingOrUnseen } from '@qed2/core-logic';
import GradingDot, { GRADING_LABELS } from './GradingDot.vue';

const props = defineProps<{
  grading: GradingOrUnseen;
  interactive?: boolean;
}>();

defineEmits<{ click: [ev: MouseEvent] }>();

const TONES: Record<GradingOrUnseen, 'ok' | 'part' | 'neutral'> = {
  good: 'ok',
  careless: 'part',
  meh: 'part',
  baffled: 'part',
  excluded: 'neutral',
  unseen: 'neutral',
};

const tone = computed(() => TONES[props.grading]);
const label = computed(() => GRADING_LABELS[props.grading]);
</script>

<template>
  <component
    :is="interactive ? 'button' : 'span'"
    class="q-grading-capsule"
    :class="[`q-grading-capsule--${tone}`, { 'q-grading-capsule--interactive': interactive }]"
    :type="interactive ? 'button' : undefined"
    @click="interactive && $emit('click', $event)"
  >
    <GradingDot :grading="grading" :size="10" />
    <span class="q-grading-capsule__label">{{ label }}</span>
    <span v-if="interactive" class="q-grading-capsule__caret" aria-hidden="true">▾</span>
  </component>
</template>

<style scoped>
/* Same pill geometry as QChip: 20px radius, 11.5px bold. */
.q-grading-capsule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11.5px;
  font-weight: 700;
  font-family: inherit;
  line-height: 1.4;
  white-space: nowrap;
}
.q-grading-capsule--ok {
  background: var(--q-ok-bg);
  border: 1px solid var(--q-ok-border);
  color: var(--q-ok-ink);
}
.q-grading-capsule--part {
  background: var(--q-part-bg);
  border: 1px solid var(--q-part-border);
  color: var(--q-part-ink);
}
.q-grading-capsule--neutral {
  background: var(--q-neutral-bg);
  border: 1px solid var(--q-neutral-border);
  color: var(--q-mut);
}
.q-grading-capsule--interactive {
  position: relative;
  cursor: pointer;
  transition: box-shadow 0.12s ease;
}
@media (pointer: coarse) {
  /* invisible hit-area extension to ~44px height; keeps the pill visual */
  .q-grading-capsule--interactive::after {
    content: '';
    position: absolute;
    inset: -10px -6px;
  }
}
@media (hover: hover) and (pointer: fine) {
  .q-grading-capsule--interactive:not(:disabled):hover {
    box-shadow: 0 0 0 3px var(--q-accent-ring);
  }
}
.q-grading-capsule--interactive:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.q-grading-capsule--interactive:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-grading-capsule__caret {
  font-size: 8.5px;
  opacity: 0.75;
  transform: translateY(0.5px);
}
</style>
