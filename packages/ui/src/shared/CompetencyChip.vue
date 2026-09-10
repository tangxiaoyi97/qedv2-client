<script setup lang="ts">
import { useI18n } from '../i18n.js';
import QChip from './QChip.vue';
import { useCompetencyDetails } from './competencies.js';

const props = defineProps<{ code: string; description?: string | undefined }>();
const openDetails = useCompetencyDetails();
const { t } = useI18n();

function open(): void {
  openDetails?.({ code: props.code, ...(props.description ? { description: props.description } : {}) });
}
</script>

<template>
  <button
    v-if="openDetails"
    type="button"
    class="q-competency-chip"
    :aria-label="t('Grundkompetenz {code} anzeigen', { code })"
    aria-haspopup="dialog"
    @click.stop="open"
    @dblclick.stop
    @keydown.enter.stop
    @keydown.space.stop
    @keyup.enter.stop
    @keyup.space.stop
  >
    <QChip>{{ code }}</QChip>
  </button>
  <QChip v-else :title="description">{{ code }}</QChip>
</template>

<style scoped>
.q-competency-chip {
  display: inline-grid;
  place-items: center;
  min-width: 44px;
  min-height: 44px;
  max-width: 100%;
  padding: 0;
  border: 0;
  border-radius: 22px;
  background: transparent;
  color: inherit;
  font: inherit;
  vertical-align: middle;
  cursor: pointer;
}
.q-competency-chip :deep(.q-chip) {
  transition: background-color var(--q-transition-fast), border-color var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .q-competency-chip:hover :deep(.q-chip) {
    background: var(--q-accent-bg);
    border-color: var(--q-accent);
  }
}
.q-competency-chip:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  .q-competency-chip :deep(.q-chip) { transition: none; }
}
</style>
