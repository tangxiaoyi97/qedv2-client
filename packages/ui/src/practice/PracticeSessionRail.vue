<script setup lang="ts">
import SessionItemList from './SessionItemList.vue';
import type { SessionItem } from './SessionItemList.vue';

defineProps<{
  items: readonly SessionItem[];
  gradedCount: number;
  total: number;
}>();

const emit = defineEmits<{ jump: [index: number] }>();
</script>

<template>
  <aside class="practice-rail" aria-label="Programmübersicht">
    <div class="practice-rail__head">
      <span class="practice-rail__title">Programm</span>
      <span class="practice-rail__count">{{ gradedCount }}/{{ total }}</span>
    </div>
    <SessionItemList :items="items" dense @jump="emit('jump', $event)" />
  </aside>
</template>

<style scoped>
.practice-rail {
  width: var(--practice-rail-width);
  flex: none;
  background: var(--q-panel);
  border-right: 1px solid var(--q-border);
  padding: 16px 10px;
  overflow-y: auto;
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
  height: calc(100dvh - 56px);
}

.practice-rail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 8px 10px;
}

.practice-rail__title {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--q-faint);
}

.practice-rail__count {
  font: 700 11px ui-monospace, Menlo, monospace;
  color: var(--q-mut-2);
}

@media (max-width: 1023px) {
  .practice-rail {
    display: none;
  }
}
</style>
