<script setup lang="ts">
import { useI18n } from '../i18n.js';

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import SessionItemList from './SessionItemList.vue';
import type { SessionItem } from './SessionItemList.vue';
import QIconButton from '../shared/QIconButton.vue';
import { useModalA11y } from '../shared/useModalA11y.js';

const { t } = useI18n();


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

/*
 * Opening lands on the question the learner is on, not on item 1: in a
 * 40-part programme the current row is otherwise several screens down.
 * Runs a frame after open so it follows the modal's own focus handling,
 * which deliberately does not scroll.
 */
let revealFrame: number | null = null;
watch(isOpen, (open) => {
  if (revealFrame !== null) cancelAnimationFrame(revealFrame);
  revealFrame = null;
  // Reset only on the way in: a swipe-dismissed panel keeps its off-screen
  // position while the leave transition fades it out.
  if (!open) return;
  resetSwipe();
  if (typeof requestAnimationFrame === 'undefined') return;
  revealFrame = requestAnimationFrame(() => {
    revealFrame = null;
    panel.value
      ?.querySelector<HTMLElement>('.q-sitems__item--current')
      ?.scrollIntoView?.({ block: 'center' });
  });
});

/*
 * Swipe to dismiss. The drawer slides in from the right edge, so a finger
 * pushing it back to the right is the natural way out on a phone — reaching
 * for the close button in the top corner is the long way round. Vertical
 * movement stays native list scrolling (`touch-action: pan-y` hands only the
 * horizontal axis to these handlers).
 */
const SWIPE_SLOP_PX = 10;
const SWIPE_CLOSE_RATIO = 0.3;
const SWIPE_CLOSE_MAX_PX = 120;
const SWIPE_FLICK_PX_PER_MS = 0.45;
/** Velocity is measured over the last stretch of movement only… */
const SWIPE_SAMPLE_MS = 100;
/** …and two samples from the same frame carry no velocity signal at all. */
const SWIPE_MIN_SAMPLE_SPAN_MS = 8;

const swipeOffset = ref(0);
const swiping = ref(false);
const swipeClosing = ref(false);
let swipePointer: number | undefined;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeClaimed = false;
let samples: Array<{ x: number; time: number }> = [];
let suppressClick = false;

function releaseVelocity(releaseTime: number): number {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return 0;
  // A finger that stopped before lifting is not flicking.
  if (releaseTime - last.time > SWIPE_SAMPLE_MS) return 0;
  const span = last.time - first.time;
  return span >= SWIPE_MIN_SAMPLE_SPAN_MS ? (last.x - first.x) / span : 0;
}

function resetSwipe(): void {
  swipePointer = undefined;
  swipeClaimed = false;
  swiping.value = false;
  swipeClosing.value = false;
  swipeOffset.value = 0;
  samples = [];
}

function onPointerDown(event: PointerEvent): void {
  suppressClick = false;
  if (event.pointerType === 'mouse' || !event.isPrimary || swipePointer !== undefined) return;
  swipePointer = event.pointerId;
  swipeStartX = event.clientX;
  swipeStartY = event.clientY;
  swipeClaimed = false;
  samples = [{ x: event.clientX, time: event.timeStamp }];
}

function onPointerMove(event: PointerEvent): void {
  if (event.pointerId !== swipePointer) return;
  const dx = event.clientX - swipeStartX;
  const dy = event.clientY - swipeStartY;
  if (!swipeClaimed) {
    if (Math.abs(dx) < SWIPE_SLOP_PX && Math.abs(dy) < SWIPE_SLOP_PX) return;
    // Only a rightward, mostly horizontal pull belongs to the drawer.
    if (dx <= 0 || Math.abs(dy) > Math.abs(dx)) {
      swipePointer = undefined;
      return;
    }
    swipeClaimed = true;
    swiping.value = true;
    (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId);
  }
  samples.push({ x: event.clientX, time: event.timeStamp });
  while (samples.length > 2 && samples[0]!.time < event.timeStamp - SWIPE_SAMPLE_MS) samples.shift();
  swipeOffset.value = Math.max(0, dx);
}

function onPointerUp(event: PointerEvent): void {
  if (event.pointerId !== swipePointer) return;
  const claimed = swipeClaimed;
  swipePointer = undefined;
  swipeClaimed = false;
  swiping.value = false;
  if (!claimed) return;
  suppressClick = true;
  const width = panel.value?.getBoundingClientRect().width || 320;
  const threshold = Math.min(SWIPE_CLOSE_MAX_PX, width * SWIPE_CLOSE_RATIO);
  if (swipeOffset.value >= threshold || releaseVelocity(event.timeStamp) >= SWIPE_FLICK_PX_PER_MS) {
    swipeClosing.value = true;
    emit('close');
  } else {
    swipeOffset.value = 0;
  }
}

function onPointerCancel(event: PointerEvent): void {
  if (event.pointerId !== swipePointer) return;
  swipePointer = undefined;
  swipeClaimed = false;
  swiping.value = false;
  swipeOffset.value = 0;
}

/** A drag that ends over a row must not also jump to it. */
function onClickCapture(event: MouseEvent): void {
  if (!suppressClick) return;
  suppressClick = false;
  event.preventDefault();
  event.stopPropagation();
}

const panelStyle = computed(() => {
  if (swipeClosing.value) return { transform: 'translateX(100%)' };
  if (swipeOffset.value <= 0) return undefined;
  return { transform: `translateX(${swipeOffset.value}px)` };
});

onBeforeUnmount(() => {
  if (revealFrame !== null) cancelAnimationFrame(revealFrame);
});
</script>

<template>
  <Transition name="practice-session-drawer">
    <div v-if="open" class="practice-session-drawer" role="dialog" aria-modal="true" :aria-label="t('Programmübersicht')">
      <button
        type="button"
        class="practice-session-drawer__backdrop q-modal-backdrop"
        :aria-label="t('Programmliste schließen')"
        tabindex="-1"
        @click="emit('close')"
      />

      <aside
        ref="panel"
        class="practice-session-drawer__panel"
        :class="{ 'practice-session-drawer__panel--swiping': swiping }"
        :style="panelStyle"
        :aria-label="t('Programmübersicht')"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
        @click.capture="onClickCapture"
      >
        <div class="practice-session-drawer__head">
          <div class="practice-session-drawer__heading">
            <span class="practice-session-drawer__title">{{ t('Programm') }}</span>
            <span class="practice-session-drawer__count">{{ gradedCount }}/{{ total }}</span>
          </div>
          <QIconButton :aria-label="t('Programmliste schließen')" @click="emit('close')" />
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
  z-index: var(--q-z-drawer);
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
  box-sizing: border-box;
  background: var(--q-card);
  border-left: 1px solid var(--q-border);
  box-shadow: -16px 0 40px rgba(0, 0, 0, 0.14);
  padding: calc(16px + env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
    calc(16px + env(safe-area-inset-bottom)) 12px;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* Vertical pans scroll the list natively; horizontal ones reach the swipe. */
  touch-action: pan-y;
  transition: transform var(--q-transition-normal);
}
.practice-session-drawer__panel--swiping {
  transition: none;
  user-select: none;
}

.practice-session-drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 2px 4px 12px 8px;
}

/* Same head as the desktop rail: label and count on one baseline. */
.practice-session-drawer__heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.practice-session-drawer__title {
  font-size: var(--q-eyebrow-size);
  font-weight: var(--q-eyebrow-weight);
  letter-spacing: var(--q-eyebrow-tracking);
  text-transform: uppercase;
  color: var(--q-faint);
}

.practice-session-drawer__count {
  font: 700 var(--q-font-small) var(--q-font-mono);
  font-variant-numeric: tabular-nums;
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
  .practice-session-drawer__panel,
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
