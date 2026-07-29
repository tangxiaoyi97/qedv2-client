<script setup lang="ts">
/**
 * Mastery picker as five visible icon buttons rather than a dropdown.
 *
 * The self-assessment step used a native `<select>`: the choice was hidden
 * behind a tap, it read as plain text while every other grading surface in
 * the app speaks in GradingDots, and on a phone it pushed the primary action
 * onto a second line. Here the five states are always on screen, in the one
 * order `SELECTABLE_GRADINGS` defines, wearing the same dots the capsule, the
 * popover and the distribution chart wear.
 *
 * The label is never dropped — the dot's shape carries the meaning and the
 * colour only assists, but neither is a substitute for the word.
 */
import { GRADING_HINTS, GRADING_LABELS, SELECTABLE_GRADINGS, type Grading } from '@qed2/core-logic';
import GradingDot from './GradingDot.vue';
import { onRadioGroupKeydown } from './radio-group.js';

defineProps<{
  /** Null until the user has picked — no state is preselected for them. */
  grading: Grading | null;
  disabled?: boolean;
  label?: string;
}>();

const emit = defineEmits<{ select: [grading: Grading] }>();
</script>

<template>
  <div
    class="q-gpick"
    role="radiogroup"
    :aria-label="label ?? 'Bewertung'"
    @keydown="onRadioGroupKeydown"
  >
    <button
      v-for="option in SELECTABLE_GRADINGS"
      :key="option"
      type="button"
      class="q-gpick__opt"
      :class="{ 'q-gpick__opt--on': option === grading }"
      role="radio"
      :aria-checked="option === grading"
      :disabled="disabled"
      :title="`${GRADING_LABELS[option]} · ${GRADING_HINTS[option]}`"
      @click="emit('select', option)"
    >
      <GradingDot :grading="option" :size="20" />
      <span class="q-gpick__label">{{ GRADING_LABELS[option] }}</span>
    </button>
  </div>
</template>

<style scoped>
.q-gpick {
  display: grid;
  /* Five equal columns that can go narrow rather than wrapping one state onto
   * its own row — the set reads as one control. */
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}

.q-gpick__opt {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  min-height: 44px;
  padding: 8px 4px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  color: var(--q-mut);
  font-family: inherit;
  cursor: pointer;
  transition: border-color var(--q-transition-fast), background var(--q-transition-fast),
    color var(--q-transition-fast);
}
.q-gpick__opt:disabled {
  cursor: default;
  opacity: 0.5;
}
.q-gpick__opt:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
@media (hover: hover) and (pointer: fine) {
  .q-gpick__opt:not(:disabled):hover {
    border-color: var(--q-border-3);
    color: var(--q-ink);
  }
}
.q-gpick__opt--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}

.q-gpick__label {
  font-size: 10px;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  /* The longest label is „Schlampigkeitsfehler"; at five columns on a phone it
   * has to be allowed to break rather than widen the grid. */
  overflow-wrap: anywhere;
  hyphens: auto;
}
</style>
