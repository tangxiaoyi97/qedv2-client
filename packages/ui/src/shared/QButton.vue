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
  transition: all var(--q-transition-fast, 0.15s ease);
}
.q-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.q-btn:active:not(:disabled) {
  transform: scale(0.97);
  opacity: 0.85;
}
.q-btn--primary {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}
@media (hover: hover) and (pointer: fine) {
  .q-btn--primary:not(:disabled):hover {
    filter: brightness(1.08);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(142, 156, 73, 0.25);
  }
}
.q-btn--secondary {
  background: var(--q-card);
  color: var(--q-ink-2);
  border: 1px solid var(--q-border-3);
  font-weight: 600;
  padding: 10px 14px;
}
@media (hover: hover) and (pointer: fine) {
  .q-btn--secondary:not(:disabled):hover {
    background: linear-gradient(135deg, var(--q-card), var(--q-panel));
    transform: translateY(-1px);
  }
}
.q-btn--ghost {
  background: transparent;
  color: var(--q-mut-2);
  font-weight: 600;
  padding: 10px 12px;
}
@media (hover: hover) and (pointer: fine) {
  .q-btn--ghost:not(:disabled):hover {
    color: var(--q-ink);
    background: var(--q-panel-2);
  }
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
