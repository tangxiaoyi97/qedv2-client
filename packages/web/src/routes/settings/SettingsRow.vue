<script setup lang="ts">
import { useId } from 'vue';

withDefaults(
  defineProps<{
    label: string;
    description?: string;
    layout?: 'inline' | 'stacked';
    tone?: 'default' | 'danger';
  }>(),
  {
    layout: 'inline',
    tone: 'default',
  },
);

defineSlots<{
  default(props: { labelId: string }): unknown;
  description?(): unknown;
  status?(): unknown;
}>();

const labelId = `settings-row-${useId()}`;
</script>

<template>
  <div
    class="q-settings-row"
    :class="[
      `q-settings-row--${layout}`,
      { 'q-settings-row--danger': tone === 'danger' },
    ]"
  >
    <div class="q-settings-row__content">
      <div :id="labelId" class="q-settings-row__label">{{ label }}</div>
      <div v-if="description || $slots.description" class="q-settings-row__description">
        <slot name="description">{{ description }}</slot>
      </div>
      <div v-if="$slots.status" class="q-settings-row__status">
        <slot name="status" />
      </div>
    </div>

    <div class="q-settings-row__control">
      <slot :label-id="labelId" />
    </div>
  </div>
</template>

<style scoped>
.q-settings-row {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--q-space-3);
  min-width: 0;
  padding: var(--q-settings-block) var(--q-settings-inset);
}

.q-settings-row--stacked {
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
}

.q-settings-row__content {
  min-width: 0;
}

.q-settings-row__label {
  color: var(--q-ink);
  font-size: var(--q-font-ui);
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.q-settings-row--danger .q-settings-row__label {
  color: var(--q-err-ink);
}

.q-settings-row__description {
  max-width: 340px;
  margin-top: var(--q-space-1);
  color: var(--q-mut-2);
  font-size: var(--q-font-small);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.q-settings-row__status {
  margin-top: var(--q-space-2);
}

/* Conditional slot content may be only a Vue comment. Do not reserve a
   status margin until there is actually a message to display. */
.q-settings-row__status:empty,
.q-settings-row__description:empty {
  display: none;
}

.q-settings-row__control {
  display: flex;
  justify-self: end;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: var(--q-space-2);
}

.q-settings-row__control :deep(.q-btn) {
  min-width: 100px;
}

.q-settings-row--stacked .q-settings-row__control {
  justify-self: stretch;
  width: 100%;
}

</style>
