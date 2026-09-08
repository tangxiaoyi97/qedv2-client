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
  gap: 12px;
  min-width: 0;
  padding: 14px 18px;
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
  font-size: 14px;
  font-weight: 600;
  line-height: 1.35;
}

.q-settings-row--danger .q-settings-row__label {
  color: var(--q-err-ink);
}

.q-settings-row__description {
  max-width: 340px;
  margin-top: 2px;
  color: var(--q-mut-2);
  font-size: 11.5px;
  line-height: 1.45;
}

.q-settings-row__status {
  margin-top: 8px;
}

.q-settings-row__control {
  display: flex;
  justify-self: end;
  justify-content: flex-end;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 8px;
}

.q-settings-row__control :deep(.q-btn) {
  min-width: 100px;
}

.q-settings-row--stacked .q-settings-row__control {
  justify-self: stretch;
  width: 100%;
}

@media (max-width: 520px) {
  .q-settings-row {
    gap: 10px;
    padding: 12px 14px;
  }
}

@media (max-width: 360px) {
  .q-settings-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  .q-settings-row__control {
    justify-self: stretch;
  }
}
</style>
