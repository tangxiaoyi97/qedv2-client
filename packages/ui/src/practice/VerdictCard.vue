<script setup lang="ts">
/**
 * Verdict card — the ONE authoritative grade feedback, rendered in the
 * content flow directly below the answer control (the verdict belongs to
 * the question, not to the bottom bar). Replaces the old ResultBanner /
 * ResultPill split with a single visual language:
 *
 *   [icon] Richtig/Falsch                    0 / 1 P
 *          …optional note…            [Lösung ↓]
 *
 * Slides in on mount (each part grades exactly once; reduced-motion users
 * get it instantly via the global media query).
 */
import { computed } from 'vue';
import type { GradeResult } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';

const props = withDefaults(
  defineProps<{
    result: GradeResult;
    /** Optional one-line gist shown under the verdict (the controls keep
     *  their own detailed per-option/per-blank comparison). */
    note?: string;
    /** Show the "Lösung ↓" shortcut (default true). Hide when the solution
     *  is already visible right below, e.g. the non-chromeless layout.
     *  NOTE: boolean props cast absent → false, so the default must be
     *  spelled out explicitly. */
    solutionLink?: boolean;
  }>(),
  { note: undefined, solutionLink: true },
);

const emit = defineEmits<{ viewSolution: [] }>();

const LABELS: Record<GradeResult['verdict'], string> = {
  correct: 'Richtig',
  partial: 'Teilweise richtig',
  incorrect: 'Falsch',
};

const verdict = computed(() => props.result.verdict);
const points = computed(() => {
  const fmt = (n: number): string => n.toLocaleString('de-AT');
  return `${fmt(props.result.awardedPoints)} / ${fmt(props.result.maxPoints)} P`;
});
</script>

<template>
  <div class="q-verdict" :class="`q-verdict--${verdict}`" role="status">
    <StateIcon class="q-verdict__icon" :state="verdict" :size="30" />
    <div class="q-verdict__main">
      <div class="q-verdict__label">{{ LABELS[verdict] }}</div>
      <div v-if="note" class="q-verdict__note">{{ note }}</div>
    </div>
    <div class="q-verdict__side">
      <div class="q-verdict__points">{{ points }}</div>
      <button
        v-if="solutionLink"
        type="button"
        class="q-verdict__solution"
        @click="emit('viewSolution')"
      >
        Lösung ↓
      </button>
    </div>
  </div>
</template>

<style scoped>
.q-verdict {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1.5px solid;
  animation: q-verdict-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@keyframes q-verdict-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}
.q-verdict--correct {
  background: var(--q-ok-bg);
  border-color: var(--q-ok-border);
  color: var(--q-ok-ink);
}
.q-verdict--partial {
  background: var(--q-part-bg);
  border-color: var(--q-part-border);
  color: var(--q-part-ink);
}
.q-verdict--incorrect {
  background: var(--q-err-bg);
  border-color: var(--q-err-border);
  color: var(--q-err-ink);
}
.q-verdict__icon {
  flex: none;
}
.q-verdict__main {
  min-width: 0;
  flex: 1;
}
.q-verdict__label {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.q-verdict__note {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.45;
  opacity: 0.85;
  overflow-wrap: break-word;
}
.q-verdict__side {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.q-verdict__points {
  font: 750 14px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.q-verdict__solution {
  border: none;
  background: none;
  padding: 0;
  font: 700 12px 'Public Sans', system-ui, sans-serif;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
@media (hover: hover) and (pointer: fine) {
  .q-verdict__solution:hover {
    opacity: 1;
  }
}
.q-verdict__solution:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  border-radius: 3px;
}
</style>
