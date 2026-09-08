<script setup lang="ts">
import { useId } from 'vue';
import './settings-layout.css';

defineProps<{
  title?: string;
  description?: string;
}>();

defineSlots<{
  default(): unknown;
  action?(): unknown;
  footer?(): unknown;
}>();

const titleId = `settings-card-${useId()}`;
</script>

<template>
  <section class="q-settings-card q-settings-panel" :aria-labelledby="title ? titleId : undefined">
    <header v-if="title || $slots.action" class="q-settings-card__header">
      <div v-if="title" class="q-settings-card__heading">
        <h2 :id="titleId" class="q-settings-card__title">{{ title }}</h2>
        <p v-if="description" class="q-settings-card__description">{{ description }}</p>
      </div>
      <div v-if="$slots.action" class="q-settings-card__action">
        <slot name="action" />
      </div>
    </header>

    <div class="q-settings-card__body">
      <slot />
    </div>

    <footer v-if="$slots.footer" class="q-settings-card__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>

<style scoped>
.q-settings-card {
  overflow: hidden;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-card);
}

.q-settings-card__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--q-space-3);
  padding: var(--q-settings-block) var(--q-settings-inset);
}

.q-settings-card__heading {
  min-width: 0;
}

.q-settings-card__title {
  margin: 0;
  color: var(--q-ink);
  font-size: var(--q-font-ui);
  font-weight: 700;
  line-height: 1.4;
}

.q-settings-card__description {
  margin: var(--q-space-1) 0 0;
  color: var(--q-mut-2);
  font-size: var(--q-font-small);
  line-height: 1.5;
}

.q-settings-card__action,
.q-settings-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--q-space-2);
  flex-wrap: wrap;
}

.q-settings-card__body {
  display: flex;
  flex-direction: column;
}

.q-settings-card__body :deep(.q-settings-row + .q-settings-row) {
  border-top: 1px solid var(--q-border-soft);
}

.q-settings-card__footer {
  padding: var(--q-settings-block) var(--q-settings-inset);
}

</style>
