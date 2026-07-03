<script setup lang="ts">
/** Pill chip — competency codes, answer-format hints ("2 aus 5"). */
defineProps<{ tone?: 'accent' | 'neutral' | 'warn' }>();
</script>

<template>
  <span class="q-chip" :class="`q-chip--${tone ?? 'accent'}`"><slot /></span>
</template>

<style scoped>
.q-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.q-chip--accent {
  background: var(--q-chip-bg);
  color: var(--q-chip-ink);
  border: 1px solid var(--q-chip-border);
}
.q-chip--neutral {
  background: var(--q-neutral-bg);
  color: var(--q-mut);
  border: 1px solid var(--q-neutral-border);
}
.q-chip--warn {
  background: var(--q-part-bg);
  color: var(--q-part-ink);
  border: 1px solid var(--q-part-border);
}
</style>
