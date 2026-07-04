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
  open: boolean;
  items: PracticeRailItem[];
  gradedCount: number;
  total: number;
}>();

const emit = defineEmits<{
  close: [];
  jump: [index: number];
}>();
</script>

<template>
  <Transition name="practice-session-drawer">
    <div v-if="open" class="practice-session-drawer">
      <button
        type="button"
        class="practice-session-drawer__backdrop"
        aria-label="Programmliste schließen"
        @click="emit('close')"
      />

      <aside class="practice-session-drawer__panel" aria-label="Programmübersicht">
        <div class="practice-session-drawer__head">
          <div>
            <span class="practice-session-drawer__title">Programm</span>
            <span class="practice-session-drawer__count">{{ gradedCount }}/{{ total }}</span>
          </div>
          <button type="button" class="practice-session-drawer__close" aria-label="Programmliste schließen" @click="emit('close')">
            ✕
          </button>
        </div>

        <ol class="practice-session-drawer__list">
          <li v-for="item in items" :key="item.partId">
            <button
              type="button"
              class="practice-session-drawer__item"
              :class="{
                'practice-session-drawer__item--current': item.state === 'current',
                'practice-session-drawer__item--done': item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect',
              }"
              :disabled="!item.jumpable && item.state !== 'current'"
              @click="item.jumpable && emit('jump', item.index)"
            >
              <span class="practice-session-drawer__icon" aria-hidden="true">
                <StateIcon
                  v-if="item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect'"
                  :state="item.state"
                  :size="16"
                />
                <span v-else-if="item.state === 'current'" class="practice-session-drawer__now">→</span>
                <span v-else class="practice-session-drawer__pending" />
              </span>
              <span class="practice-session-drawer__nr">{{ item.index + 1 }}</span>
              <span class="practice-session-drawer__label">
                {{ item.title }}<template v-if="item.partLabel"> · {{ item.partLabel }}</template>
              </span>
            </button>
          </li>
        </ol>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.practice-session-drawer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: none;
}

.practice-session-drawer__backdrop {
  position: absolute;
  inset: 0;
  border: none;
  background: rgba(0, 0, 0, 0.34);
}

.practice-session-drawer__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(340px, 88vw);
  background: var(--q-card);
  border-left: 1px solid var(--q-border);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.14);
  padding: 16px 12px calc(16px + env(safe-area-inset-bottom));
  overflow-y: auto;
}

.practice-session-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 2px 4px 12px;
}

.practice-session-drawer__title {
  display: block;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--q-faint);
}

.practice-session-drawer__count {
  font: 700 12px ui-monospace, Menlo, monospace;
  color: var(--q-mut-2);
}

.practice-session-drawer__close {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--q-panel);
  color: var(--q-mut-2);
  cursor: pointer;
}

.practice-session-drawer__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.practice-session-drawer__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--q-mut);
  font: 600 13px 'Public Sans', system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
}

.practice-session-drawer__item:disabled {
  cursor: default;
}

.practice-session-drawer__item--done {
  color: var(--q-faint);
}

.practice-session-drawer__item--current {
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-weight: 800;
}

.practice-session-drawer__item:not(:disabled):hover {
  background: var(--q-panel);
}

.practice-session-drawer__icon {
  width: 18px;
  display: inline-flex;
  justify-content: center;
  flex: none;
}

.practice-session-drawer__now {
  color: var(--q-accent-strong);
  font-weight: 800;
}

.practice-session-drawer__pending {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  display: inline-block;
}

.practice-session-drawer__nr {
  font: 700 11px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  width: 24px;
  flex: none;
  text-align: right;
}

.practice-session-drawer__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.practice-session-drawer-enter-active,
.practice-session-drawer-leave-active {
  transition: opacity 0.16s ease;
}

.practice-session-drawer-enter-active .practice-session-drawer__panel,
.practice-session-drawer-leave-active .practice-session-drawer__panel {
  transition: transform 0.18s ease;
}

.practice-session-drawer-enter-from,
.practice-session-drawer-leave-to {
  opacity: 0;
}

.practice-session-drawer-enter-from .practice-session-drawer__panel,
.practice-session-drawer-leave-to .practice-session-drawer__panel {
  transform: translateX(20px);
}

@media (max-width: 1023px) {
  .practice-session-drawer {
    display: block;
  }
}
</style>
