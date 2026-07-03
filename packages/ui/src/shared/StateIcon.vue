<script setup lang="ts">
/**
 * State glyphs — never color-only (a11y): ✓ correct, ✕ wrong, half-disc
 * partial, dot neutral, dashed-✓ missed(-correct).
 */
defineProps<{
  state: 'correct' | 'incorrect' | 'partial' | 'neutral' | 'missed';
  size?: number;
}>();
</script>

<template>
  <span
    class="q-state-icon"
    :class="`q-state-icon--${state}`"
    :style="{ width: `${size ?? 22}px`, height: `${size ?? 22}px`, fontSize: `${(size ?? 22) * 0.58}px` }"
    aria-hidden="true"
  >
    <template v-if="state === 'correct' || state === 'missed'">✓</template>
    <template v-else-if="state === 'incorrect'">✕</template>
    <template v-else-if="state === 'neutral'">·</template>
  </span>
</template>

<style scoped>
.q-state-icon {
  border-radius: 50%;
  display: inline-grid;
  place-items: center;
  font-weight: 700;
  flex: none;
  box-sizing: border-box;
}
.q-state-icon--correct {
  background: var(--q-ok);
  color: var(--q-on-ok);
}
.q-state-icon--incorrect {
  background: var(--q-err);
  color: var(--q-on-err);
}
.q-state-icon--partial {
  border: 2px solid var(--q-part);
  background: linear-gradient(90deg, var(--q-part) 50%, transparent 50%);
}
.q-state-icon--neutral {
  background: var(--q-neutral);
  color: var(--q-card);
}
.q-state-icon--missed {
  border: 1.5px solid var(--q-ok);
  color: var(--q-ok);
  background: transparent;
}
</style>
