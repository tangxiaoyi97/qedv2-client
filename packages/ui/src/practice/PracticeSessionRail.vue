<script setup lang="ts">
import { useI18n } from '../i18n.js';

import { nextTick, ref, watch } from 'vue';
import SessionItemList from './SessionItemList.vue';
import type { SessionItem } from './SessionItemList.vue';

const { t } = useI18n();

const props = defineProps<{
  items: readonly SessionItem[];
  gradedCount: number;
  total: number;
}>();

const emit = defineEmits<{ jump: [index: number] }>();

/*
 * Advancing past the last visible row used to leave the current question
 * below the fold of the rail. Only the rail's own scroll offset moves —
 * never the page, and never while the rail is collapsed (inert).
 */
const rail = ref<HTMLElement | null>(null);
watch(
  () => props.items.findIndex((item) => item.state === 'current'),
  async (index) => {
    if (index < 0) return;
    await nextTick();
    const container = rail.value;
    const row = container?.querySelector<HTMLElement>('.q-sitems__item--current');
    if (!container || !row || container.closest('[inert]')) return;
    const box = container.getBoundingClientRect();
    const target = row.getBoundingClientRect();
    if (target.top < box.top) container.scrollTop -= box.top - target.top + 8;
    else if (target.bottom > box.bottom) container.scrollTop += target.bottom - box.bottom + 8;
  },
);
</script>

<template>
  <aside ref="rail" class="practice-rail" :aria-label="t('Programmübersicht')">
    <div class="practice-rail__head">
      <span class="practice-rail__title">{{ t('Programm') }}</span>
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
  top: var(--q-topbar-height);
  height: calc(100vh - var(--q-topbar-height));
  height: calc(100dvh - var(--q-topbar-height));
}

.practice-rail__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 8px 10px;
}

.practice-rail__title {
  font-size: var(--q-eyebrow-size);
  font-weight: var(--q-eyebrow-weight);
  letter-spacing: var(--q-eyebrow-tracking);
  text-transform: uppercase;
  color: var(--q-faint);
}

.practice-rail__count {
  font: 700 var(--q-font-xs) var(--q-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--q-mut-2);
}

@media (max-width: 1023px) {
  .practice-rail {
    display: none;
  }
}
</style>
