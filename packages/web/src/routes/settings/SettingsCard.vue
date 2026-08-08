<script setup lang="ts">
import { useId } from 'vue';

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
  <section class="q-settings-card" :aria-labelledby="title ? titleId : undefined">
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
  border-radius: 12px;
}

.q-settings-card__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
}

.q-settings-card__heading {
  min-width: 0;
}

.q-settings-card__title {
  margin: 0;
  color: var(--q-ink);
  font-size: 13.5px;
  font-weight: 700;
  line-height: 1.35;
}

.q-settings-card__description {
  margin: 2px 0 0;
  color: var(--q-mut-2);
  font-size: 11.5px;
  line-height: 1.45;
}

.q-settings-card__action,
.q-settings-card__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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
  padding: 0 20px 16px;
}

@media (max-width: 520px) {
  .q-settings-card__header {
    grid-template-columns: minmax(0, 1fr);
  }

  .q-settings-card__action {
    width: 100%;
  }
}
</style>
