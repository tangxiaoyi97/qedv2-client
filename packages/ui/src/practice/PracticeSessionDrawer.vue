<script setup lang="ts">
import { computed, ref } from 'vue';
import SessionItemList from './SessionItemList.vue';
import type { SessionItem } from './SessionItemList.vue';
import { useModalA11y } from '../shared/useModalA11y.js';


const props = defineProps<{
  open: boolean;
  items: readonly SessionItem[];
  gradedCount: number;
  total: number;
}>();

const emit = defineEmits<{
  close: [];
  jump: [index: number];
}>();

const isOpen = computed(() => props.open);
const panel = ref<HTMLElement | null>(null);
useModalA11y(panel, isOpen, () => emit('close'));
</script>

<template>
  <Transition name="practice-session-drawer">
    <div v-if="open" class="practice-session-drawer" role="dialog" aria-modal="true" aria-label="Programmübersicht">
      <button
        type="button"
        class="practice-session-drawer__backdrop q-modal-backdrop"
        aria-label="Programmliste schließen"
        tabindex="-1"
        @click="emit('close')"
      />

      <aside ref="panel" class="practice-session-drawer__panel" aria-label="Programmübersicht">
        <div class="practice-session-drawer__head">
          <div>
            <span class="practice-session-drawer__title">Programm</span>
            <span class="practice-session-drawer__count">{{ gradedCount }}/{{ total }}</span>
          </div>
          <button type="button" class="q-dialog-close" aria-label="Programmliste schließen" @click="emit('close')">
            ✕
          </button>
        </div>

        <SessionItemList :items="items" @jump="emit('jump', $event)" />
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
  padding: calc(16px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom));
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

@media (prefers-reduced-motion: reduce) {
  .practice-session-drawer-enter-active,
  .practice-session-drawer-leave-active {
    transition: opacity 100ms linear;
  }
  .practice-session-drawer-enter-active .practice-session-drawer__panel,
  .practice-session-drawer-leave-active .practice-session-drawer__panel {
    transition: none;
  }
  .practice-session-drawer-enter-from .practice-session-drawer__panel,
  .practice-session-drawer-leave-to .practice-session-drawer__panel {
    transform: none;
  }
}

@media (max-width: 1023px) {
  .practice-session-drawer {
    display: block;
  }
}
</style>
