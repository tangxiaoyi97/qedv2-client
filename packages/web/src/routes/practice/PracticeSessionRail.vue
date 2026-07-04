<script setup lang="ts">
import { StateIcon } from '@qed2/ui';

interface PracticeRailItem {
  index: number;
  partId: string;
  title: string;
  partLabel: string | undefined;
  state: 'correct' | 'partial' | 'incorrect' | 'current' | 'pending';
  jumpable: boolean;
}

defineProps<{
  items: PracticeRailItem[];
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
    <ol class="practice-rail__list">
      <li v-for="item in items" :key="item.partId">
        <button
          type="button"
          class="practice-rail__item"
          :class="{
            'practice-rail__item--current': item.state === 'current',
            'practice-rail__item--done': item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect',
          }"
          :disabled="!item.jumpable && item.state !== 'current'"
          :title="item.state === 'current' ? 'Aktuelle Aufgabe' : item.jumpable ? 'Zu dieser Aufgabe springen' : 'Bereits beantwortet'"
          @click="item.jumpable && emit('jump', item.index)"
        >
          <span class="practice-rail__icon" aria-hidden="true">
            <StateIcon
              v-if="item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect'"
              :state="item.state"
              :size="15"
            />
            <span v-else-if="item.state === 'current'" class="practice-rail__now">→</span>
            <span v-else class="practice-rail__pending" />
          </span>
          <span class="practice-rail__nr">{{ item.index + 1 }}</span>
          <span class="practice-rail__label">
            {{ item.title }}<template v-if="item.partLabel"> · {{ item.partLabel }}</template>
          </span>
        </button>
      </li>
    </ol>
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

.practice-rail__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.practice-rail__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--q-mut);
  font: 500 12px 'Public Sans', system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
}

.practice-rail__item:disabled {
  cursor: default;
}

.practice-rail__item--done {
  color: var(--q-faint);
}

.practice-rail__item--current {
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-weight: 700;
}

.practice-rail__item:not(:disabled):hover {
  background: var(--q-panel-2);
}

.practice-rail__item--current:hover {
  background: var(--q-accent-bg);
}

.practice-rail__icon {
  width: 16px;
  display: inline-flex;
  justify-content: center;
  flex: none;
}

.practice-rail__now {
  color: var(--q-accent-strong);
  font-weight: 800;
}

.practice-rail__pending {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  display: inline-block;
}

.practice-rail__nr {
  font: 600 10.5px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  width: 20px;
  flex: none;
  text-align: right;
}

.practice-rail__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1023px) {
  .practice-rail {
    display: none;
  }
}
</style>
