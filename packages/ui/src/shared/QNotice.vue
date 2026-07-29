<script setup lang="ts">
/**
 * The "nothing here" / "that failed" panel every list view needs.
 *
 * Five views had a near-identical eleven-declaration block for this, three of
 * them character-for-character. The default slot carries the message, the
 * `action` slot whatever button or link belongs with it.
 */
withDefaults(
  defineProps<{
    /** `error` raises the tone and announces itself; `empty` stays quiet. */
    tone?: 'empty' | 'error';
  }>(),
  { tone: 'empty' },
);
</script>

<template>
  <div
    class="q-notice"
    :class="`q-notice--${tone}`"
    :role="tone === 'error' ? 'alert' : undefined"
  >
    <p class="q-notice__text"><slot /></p>
    <slot name="action" />
  </div>
</template>

<style scoped>
.q-notice {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px;
  border-radius: 10px;
  background: var(--q-panel);
  color: var(--q-mut-2);
  font-size: 13px;
  text-align: center;
}
.q-notice--error {
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
}
.q-notice__text {
  margin: 0;
}
</style>
