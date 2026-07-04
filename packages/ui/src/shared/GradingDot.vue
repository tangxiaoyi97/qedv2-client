<script lang="ts">
import type { GradingOrUnseen } from '@qed2/core-logic';

/**
 * German state names (grading supplement §1.5). Named export so sibling
 * grading components (GradingCapsule, GradingMenu) reuse the exact strings.
 */
export const GRADING_LABELS: Record<GradingOrUnseen, string> = {
  good: 'Gut',
  careless: 'Schlampigkeitsfehler',
  meh: 'Halb verstanden',
  baffled: 'Keine Ahnung',
  excluded: 'Ausgeschlossen',
  unseen: 'Ungesehen',
};
</script>

<script setup lang="ts">
/**
 * Mastery grading dot (supplement §1.5) — six visuals where the SHAPE
 * carries the meaning and color only assists (a11y, never color-only):
 * good = solid filled, careless = half-filled, meh = outlined,
 * baffled = dashed outline, excluded = grey ⊗, unseen = faint outline.
 */
import { computed } from 'vue';

const props = defineProps<{
  grading: GradingOrUnseen;
  size?: number;
  title?: string;
}>();

const label = computed(() => props.title ?? GRADING_LABELS[props.grading]);
</script>

<template>
  <svg
    class="q-grading-dot"
    :class="`q-grading-dot--${grading}`"
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 14 14"
    role="img"
    :aria-label="GRADING_LABELS[grading]"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>{{ label }}</title>

    <!-- good: solid filled circle -->
    <circle v-if="grading === 'good'" cx="7" cy="7" r="6.5" fill="var(--q-ok)" />

    <!-- careless: half-filled (left half) circle with solid border -->
    <template v-else-if="grading === 'careless'">
      <circle cx="7" cy="7" r="5.75" fill="none" stroke="var(--q-part)" stroke-width="2" />
      <path d="M7 2.1 A4.9 4.9 0 0 0 7 11.9 Z" fill="var(--q-part)" />
    </template>

    <!-- meh: outlined circle -->
    <circle
      v-else-if="grading === 'meh'"
      cx="7"
      cy="7"
      r="5.75"
      fill="none"
      stroke="var(--q-part)"
      stroke-width="2"
    />

    <!-- baffled: dashed outlined circle -->
    <circle
      v-else-if="grading === 'baffled'"
      cx="7"
      cy="7"
      r="5.75"
      fill="none"
      stroke="var(--q-part)"
      stroke-width="2"
      stroke-dasharray="2.8 2.2"
    />

    <!-- excluded: grey circle with inscribed ✕ (⊗ style) -->
    <template v-else-if="grading === 'excluded'">
      <circle cx="7" cy="7" r="6" fill="none" stroke="var(--q-neutral)" stroke-width="1.5" />
      <line
        x1="4.7"
        y1="4.7"
        x2="9.3"
        y2="9.3"
        stroke="var(--q-neutral)"
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <line
        x1="9.3"
        y1="4.7"
        x2="4.7"
        y2="9.3"
        stroke="var(--q-neutral)"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </template>

    <!-- unseen: faint outlined circle -->
    <circle v-else cx="7" cy="7" r="6" fill="none" stroke="var(--q-btn-border)" stroke-width="1.5" />
  </svg>
</template>

<style scoped>
.q-grading-dot {
  display: inline-block;
  vertical-align: middle;
  flex: none;
}
</style>
