<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}>();
defineEmits<{ click: [ev: MouseEvent] }>();
</script>

<template>
  <button
    class="q-btn"
    :class="`q-btn--${variant ?? 'primary'}`"
    :disabled="disabled"
    :type="type ?? 'button'"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<style scoped>
.q-btn {
  font: 700 13.5px 'Public Sans', system-ui, sans-serif;
  padding: 11px 22px;
  border-radius: 9px;
  cursor: pointer;
  border: none;
  transition: filter 0.12s ease, background 0.12s ease;
}
.q-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.q-btn--primary {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}
.q-btn--primary:not(:disabled):hover {
  filter: brightness(1.08);
}
.q-btn--secondary {
  background: var(--q-card);
  color: var(--q-ink-2);
  border: 1px solid var(--q-border-3);
  font-weight: 600;
  padding: 10px 14px;
}
.q-btn--secondary:not(:disabled):hover {
  background: var(--q-panel);
}
.q-btn--ghost {
  background: transparent;
  color: var(--q-mut-2);
  font-weight: 600;
  padding: 10px 12px;
}
.q-btn--ghost:not(:disabled):hover {
  color: var(--q-ink);
}
.q-btn--danger {
  background: var(--q-card);
  color: var(--q-err);
  border: 1px solid var(--q-err-border);
  font-weight: 700;
  padding: 9px 15px;
  font-size: 12.5px;
}
.q-btn:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
</style>
