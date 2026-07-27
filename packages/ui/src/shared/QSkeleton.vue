<script setup lang="ts">
/**
 * Component-level loading placeholder: a stack of shimmering blocks shaped
 * like the rows that are about to replace them.
 *
 * The point is that the layout does not jump when the data lands, so callers
 * pass the height their real rows have. The shimmer surface itself lives in
 * styles/tokens.css (`.q-skeleton`) and is shared with QLoadingPanel — every
 * waiting state in the app moves at the same speed.
 */
withDefaults(
  defineProps<{
    /** How many placeholder rows to draw. */
    rows?: number;
    /** Height of one row — match the real row so nothing shifts. */
    height?: string;
    radius?: string;
    gap?: string;
    /** Announced once instead of the rows, which are decorative. */
    label?: string;
  }>(),
  { rows: 6, height: '44px', radius: '10px', gap: '8px', label: 'Wird geladen …' },
);
</script>

<template>
  <div class="q-skeleton-list" :style="{ gap }" role="status" :aria-label="label">
    <div
      v-for="i in rows"
      :key="i"
      class="q-skeleton q-skeleton-list__row"
      :style="{ height, borderRadius: radius }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.q-skeleton-list {
  display: flex;
  flex-direction: column;
}
.q-skeleton-list__row {
  flex: none;
}
/* Fade the tail so the stack reads as "and more below" rather than a wall. */
.q-skeleton-list__row:nth-child(n + 4) {
  opacity: 0.7;
}
.q-skeleton-list__row:nth-child(n + 6) {
  opacity: 0.45;
}
</style>
