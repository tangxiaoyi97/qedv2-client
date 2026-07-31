<script setup lang="ts">
/**
 * The mark that says "a machine wrote this".
 *
 * One component, because it appears next to the official Lösungsweg and next
 * to a grading suggestion, and those two places must never drift apart — the
 * whole job of this badge is that a reader recognises it instantly, without
 * reading it, and that only works if it is identical everywhere.
 *
 * It was a flat grey chip built from the neutral palette, which is the same
 * palette as disabled controls and secondary metadata; it read as chrome. The
 * accent-tinted chip reads as a label on the content. The spark is drawn
 * rather than typed: ✦ renders at wildly different sizes and baselines across
 * platforms, and this sits inside a line of text.
 */
withDefaults(
  defineProps<{
    /** `sm` for a heading row, `md` when it stands alone in a tappable row. */
    size?: 'sm' | 'md';
  }>(),
  { size: 'sm' },
);
</script>

<template>
  <span class="q-aibadge" :class="`q-aibadge--${size}`">
    <!--
      One spark, not two. A second smaller one was there for a moment and at
      10px it did not read as a flourish, it read as a speck of dirt on the
      screen — detail below the size it will actually be seen at is noise.
    -->
    <svg class="q-aibadge__spark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M6 0 7.1 4.9 12 6 7.1 7.1 6 12 4.9 7.1 0 6 4.9 4.9Z" fill="currentColor" />
    </svg>
    <span class="q-aibadge__text">KI</span>
  </span>
</template>

<style scoped>
.q-aibadge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  border-radius: 999px;
  background: var(--q-chip-bg);
  border: 1px solid var(--q-chip-border);
  color: var(--q-chip-ink);
  font-family: 'Public Sans', system-ui, sans-serif;
  font-weight: 800;
  /* Two letters only — the wide tracking a longer word wants makes "KI" read
   * as two separate marks. */
  letter-spacing: 0.05em;
  /* Sits in a line of prose; never let it stretch the line box. */
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}

.q-aibadge--sm {
  padding: 3px 7px 3px 6px;
  font-size: 9.5px;
}
.q-aibadge--md {
  padding: 4px 9px 4px 7px;
  font-size: 10.5px;
}

.q-aibadge__spark {
  flex: none;
  display: block;
}
.q-aibadge--sm .q-aibadge__spark {
  width: 9px;
  height: 9px;
}
.q-aibadge--md .q-aibadge__spark {
  width: 10px;
  height: 10px;
}

/* The trailing letter-spacing would otherwise push the K/I off-centre. */
.q-aibadge__text {
  margin-right: -0.05em;
}
</style>
