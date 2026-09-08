<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';
defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  type?: 'button' | 'submit';
}>();
defineEmits<{ click: [ev: MouseEvent] }>();
</script>

<template>
  <button
    class="q-btn"
    :class="[`q-btn--${variant ?? 'primary'}`, { 'q-btn--loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    :type="type ?? 'button'"
    @click="$emit('click', $event)"
  >
    <span v-if="loading" class="q-btn__spinner" aria-hidden="true"><LoaderCircle :size="18" /></span>
    <span class="q-btn__content"><slot /></span>
  </button>
</template>

<style scoped>
.q-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 700 var(--q-font-ui, 14px) 'Public Sans', system-ui, sans-serif;
  min-height: var(--q-control-height);
  box-sizing: border-box;
  padding: 11px 20px;
  border-radius: var(--q-radius-control, 10px);
  cursor: pointer;
  border: none;
  transition: background-color var(--q-transition-fast), color var(--q-transition-fast), border-color var(--q-transition-fast), opacity var(--q-transition-fast), transform var(--q-transition-fast);
}
.q-btn__content { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.q-btn--loading .q-btn__content { opacity: 0; }
.q-btn--loading:disabled { opacity: 0.8; cursor: wait; }
.q-btn__spinner { position: absolute; inset: 0; display: grid; place-items: center; }
.q-btn__spinner svg { animation: q-btn-spin 0.8s linear infinite; }
@keyframes q-btn-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .q-btn, .q-btn__spinner svg { transition: none; animation: none; }
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
    opacity: 0.9;
  }
}
.q-btn--secondary {
  background: var(--q-card);
  color: var(--q-ink-2);
  border: 1px solid var(--q-border-3);
  font-weight: 600;
  /* same box as primary: one padding/font-size across all variants so
   * buttons line up when placed side by side */
  padding: 10px 20px;
}
@media (hover: hover) and (pointer: fine) {
  .q-btn--secondary:not(:disabled):hover {
    background: var(--q-panel);
  }
}
.q-btn--ghost {
  background: transparent;
  color: var(--q-mut-2);
  font-weight: 600;
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
  padding: 10px 20px;
}
.q-btn:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
</style>
