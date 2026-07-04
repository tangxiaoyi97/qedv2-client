<script setup lang="ts">
/**
 * Ever-present grading control (supplement §1.2): a GradingCapsule trigger
 * that opens an anchored popover listing the FIVE selectable states
 * (good / careless / meh / baffled / excluded — `unseen` is the absence of
 * a record, never selectable). Manual picks always override auto grading;
 * that policy lives in core-logic — this component only emits `select`.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Grading, GradingOrUnseen } from '@qed2/core-logic';
import GradingCapsule from './GradingCapsule.vue';
import GradingDot, { GRADING_LABELS } from './GradingDot.vue';

const props = defineProps<{
  grading: GradingOrUnseen;
  disabled?: boolean;
}>();

const emit = defineEmits<{ select: [g: Grading] }>();

const SELECTABLE: readonly Grading[] = ['good', 'careless', 'meh', 'baffled', 'excluded'];

const HINTS: Record<Grading, string> = {
  good: 'Gemeistert',
  careless: 'Eigentlich gekonnt',
  meh: 'Bald wiederholen',
  baffled: 'Von vorn',
  excluded: 'Nie wieder üben',
};

const root = ref<HTMLElement | null>(null);
const open = ref(false);

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

function pick(g: Grading): void {
  emit('select', g);
  open.value = false;
}

function onDocumentClick(ev: MouseEvent): void {
  if (!open.value) return;
  const target = ev.target as Node | null;
  if (root.value && target && !root.value.contains(target)) open.value = false;
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="q-grading-menu">
    <GradingCapsule
      :grading="grading"
      interactive
      :disabled="disabled || undefined"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      title="Bewertung ändern"
      @click="toggle"
    />

    <div v-if="open" class="q-grading-menu__popover" role="menu" aria-label="Bewertung">
      <button
        v-for="g in SELECTABLE"
        :key="g"
        type="button"
        class="q-grading-menu__option"
        :class="{ 'q-grading-menu__option--current': g === grading }"
        role="menuitemradio"
        :aria-checked="g === grading ? 'true' : 'false'"
        @click="pick(g)"
      >
        <GradingDot :grading="g" :size="14" />
        <span class="q-grading-menu__texts">
          <span class="q-grading-menu__label">{{ GRADING_LABELS[g] }}</span>
          <span class="q-grading-menu__hint">{{ HINTS[g] }}</span>
        </span>
        <span v-if="g === grading" class="q-grading-menu__check" aria-hidden="true">✓</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.q-grading-menu {
  position: relative;
  display: inline-flex;
}
.q-grading-menu__popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  min-width: 232px;
  padding: 6px;
  background: var(--q-card);
  border: 1px solid var(--q-border-2);
  border-radius: 12px;
  box-shadow: var(--q-shadow-panel);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.q-grading-menu__option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  color: var(--q-ink);
}
.q-grading-menu__option:hover {
  background: var(--q-panel);
}
.q-grading-menu__option:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}
.q-grading-menu__option--current {
  background: var(--q-accent-bg);
}
.q-grading-menu__texts {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.q-grading-menu__label {
  font-size: 13px;
  font-weight: 700;
}
.q-grading-menu__hint {
  font-size: 11.5px;
  color: var(--q-mut-2);
}
.q-grading-menu__check {
  margin-left: auto;
  font-weight: 800;
  font-size: 13px;
  color: var(--q-accent-strong);
  flex: none;
}
</style>
