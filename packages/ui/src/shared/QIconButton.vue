<script setup lang="ts">
import { ref } from 'vue';
import { X } from 'lucide-vue-next';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    disabled: false,
    type: 'button',
  },
);

defineEmits<{ click: [event: MouseEvent] }>();

const button = ref<HTMLButtonElement | null>(null);

/** Keeps programmatic focus available when a dialog owns this component. */
function focus(options?: FocusOptions): void {
  button.value?.focus(options);
}

defineExpose({ focus });
</script>

<template>
  <button
    ref="button"
    v-bind="$attrs"
    class="q-icon-btn"
    :disabled="props.disabled"
    :type="props.type"
    @click="$emit('click', $event)"
  >
    <X :size="20" :stroke-width="2" aria-hidden="true" />
  </button>
</template>

<style scoped>
.q-icon-btn {
  width: var(--q-icon-control-size);
  min-width: var(--q-icon-control-size);
  height: var(--q-icon-control-size);
  flex: 0 0 var(--q-icon-control-size);
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--q-mut-2);
  line-height: 0;
  cursor: pointer;
  transition:
    background var(--q-transition-fast),
    color var(--q-transition-fast),
    opacity var(--q-transition-fast);
}

.q-icon-btn :deep(svg) {
  display: block;
  width: var(--q-icon-glyph-size);
  height: var(--q-icon-glyph-size);
}

@media (hover: hover) and (pointer: fine) {
  .q-icon-btn:not(:disabled):hover {
    background: var(--q-panel-2);
    color: var(--q-ink);
  }
}

.q-icon-btn:active:not(:disabled) {
  background: var(--q-panel);
}

.q-icon-btn:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

.q-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
