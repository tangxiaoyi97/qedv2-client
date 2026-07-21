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

/** Matches the popover's CSS min-width / estimated height — used for the
 *  overflow checks. */
const POPOVER_WIDTH = 232;
const POPOVER_HEIGHT = 5 * 44 + 12; // 5 options + padding

const root = ref<HTMLElement | null>(null);
const open = ref(false);
const alignRight = ref(false);
const openUp = ref(false);
const popoverEl = ref<HTMLElement | null>(null);

function toggle(): void {
  if (props.disabled) return;
  if (!open.value && root.value) {
    // Flip to right-anchored when a left-anchored popover would poke past
    // the viewport edge (narrow screens, chips before the trigger); flip
    // UP when there is no room below (e.g. triggers near the bottom bar).
    const rect = root.value.getBoundingClientRect();
    alignRight.value = rect.left + POPOVER_WIDTH > window.innerWidth - 12;
    openUp.value = rect.bottom + 6 + POPOVER_HEIGHT > window.innerHeight && rect.top > POPOVER_HEIGHT;
    open.value = true;
    // Menus focus their current item on open (WAI-ARIA menu pattern).
    requestAnimationFrame(() => {
      const el =
        popoverEl.value?.querySelector<HTMLElement>('.q-grading-menu__option--current') ??
        popoverEl.value?.querySelector<HTMLElement>('.q-grading-menu__option');
      el?.focus();
    });
    return;
  }
  open.value = false;
}

function pick(g: Grading): void {
  emit('select', g);
  open.value = false;
  refocusTrigger();
}

/** Esc/blur closing returns focus to the capsule that opened the menu. */
function refocusTrigger(): void {
  root.value?.querySelector<HTMLElement>('button')?.focus();
}

function onPopoverKeydown(ev: KeyboardEvent): void {
  if (!popoverEl.value) return;
  const items = [...popoverEl.value.querySelectorAll<HTMLElement>('.q-grading-menu__option')];
  const idx = items.indexOf(document.activeElement as HTMLElement);
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const next = ev.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    items[0]?.focus();
  } else if (ev.key === 'End') {
    ev.preventDefault();
    items[items.length - 1]?.focus();
  }
}

function onDocumentClick(ev: MouseEvent): void {
  if (!open.value) return;
  const target = ev.target as Node | null;
  if (root.value && target && !root.value.contains(target)) open.value = false;
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && open.value) {
    open.value = false;
    refocusTrigger();
  }
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

    <div
      v-if="open"
      ref="popoverEl"
      class="q-grading-menu__popover"
      :class="{ 'q-grading-menu__popover--right': alignRight, 'q-grading-menu__popover--up': openUp }"
      role="menu"
      aria-label="Bewertung"
      @keydown="onPopoverKeydown"
    >
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
  max-width: calc(100vw - 24px);
  padding: 6px;
  background: var(--q-card);
  border: 1px solid var(--q-border-2);
  border-radius: 12px;
  box-shadow: var(--q-shadow-panel);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.q-grading-menu__popover--right {
  left: auto;
  right: 0;
}
.q-grading-menu__popover--up {
  top: auto;
  bottom: calc(100% + 6px);
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
@media (hover: hover) and (pointer: fine) {
  .q-grading-menu__option:hover {
    background: var(--q-panel);
  }
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
