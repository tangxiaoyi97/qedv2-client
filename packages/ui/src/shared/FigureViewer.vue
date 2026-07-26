<script setup lang="ts">
/**
 * Fullscreen pinch/pan viewer for a single figure.
 *
 * The app disables browser zoom outright (viewport `user-scalable=no` plus
 * `touch-action: manipulation`) to keep the fixed practice chrome stable. That
 * is fine for UI, but SRDP figures — function graphs, geometry diagrams,
 * labelled axes — become unreadable on a phone with no way to get closer. This
 * overlay is the deliberate exception: it opts out of the global lock with
 * `touch-action: none` and drives the transform itself, so the reader gets
 * zoom exactly where it matters and nowhere else.
 *
 * Gestures: two-finger pinch, one-finger pan while zoomed, double-tap (and
 * double-click) to toggle, wheel/trackpad to zoom, all anchored on the point
 * under the cursor or the pinch midpoint.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { lockBodyScroll, unlockBodyScroll } from './scroll-lock.js';

const props = defineProps<{
  src: string;
  alt?: string;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Zoom level a double-tap jumps to. */
const DOUBLE_TAP_SCALE = 2.5;
/** A pointer-up counts as a tap only within these bounds of the previous one. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;

const stage = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);

const scale = ref(1);
const tx = ref(0);
const ty = ref(0);

const transform = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  cursor: scale.value > MIN_SCALE ? 'grab' : 'zoom-in',
}));

const zoomed = computed(() => scale.value > MIN_SCALE + 0.01);

/* --- gesture bookkeeping -------------------------------------------------- */

const pointers = new Map<number, { x: number; y: number }>();
let pinchStartDistance = 0;
let pinchStartScale = 1;
let panOrigin = { x: 0, y: 0, tx: 0, ty: 0 };
let lastTap = { time: Number.NEGATIVE_INFINITY, x: 0, y: 0 };
let dragged = false;

const clampScale = (value: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

/** Pointer position relative to the stage centre — the transform's origin. */
function stagePoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = stage.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
}

/** Never let the figure be dragged so far that it leaves the stage entirely. */
function clampTranslation(): void {
  const el = image.value;
  const host = stage.value;
  if (!el || !host) return;
  const maxX = Math.max(0, (el.offsetWidth * scale.value - host.clientWidth) / 2);
  const maxY = Math.max(0, (el.offsetHeight * scale.value - host.clientHeight) / 2);
  tx.value = Math.min(maxX, Math.max(-maxX, tx.value));
  ty.value = Math.min(maxY, Math.max(-maxY, ty.value));
}

/** Zoom to `next`, keeping the content under (px, py) pinned in place. */
function zoomAround(next: number, px: number, py: number): void {
  const target = clampScale(next);
  const factor = target / scale.value;
  tx.value = px - (px - tx.value) * factor;
  ty.value = py - (py - ty.value) * factor;
  scale.value = target;
  if (target === MIN_SCALE) {
    tx.value = 0;
    ty.value = 0;
  } else {
    clampTranslation();
  }
}

function reset(): void {
  scale.value = MIN_SCALE;
  tx.value = 0;
  ty.value = 0;
}

function distanceBetweenPointers(): number {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpointOfPointers(): { x: number; y: number } {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return { x: 0, y: 0 };
  return stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
}

function onPointerDown(event: PointerEvent): void {
  (event.target as Element).setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  dragged = false;
  if (pointers.size === 1) {
    panOrigin = { x: event.clientX, y: event.clientY, tx: tx.value, ty: ty.value };
  } else if (pointers.size === 2) {
    pinchStartDistance = distanceBetweenPointers();
    pinchStartScale = scale.value;
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2) {
    if (pinchStartDistance === 0) return;
    dragged = true;
    const midpoint = midpointOfPointers();
    zoomAround(
      (pinchStartScale * distanceBetweenPointers()) / pinchStartDistance,
      midpoint.x,
      midpoint.y,
    );
    return;
  }

  if (!zoomed.value) return; // at 1x there is nothing to pan
  const dx = event.clientX - panOrigin.x;
  const dy = event.clientY - panOrigin.y;
  if (Math.hypot(dx, dy) > 3) dragged = true;
  tx.value = panOrigin.tx + dx;
  ty.value = panOrigin.ty + dy;
  clampTranslation();
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (pointers.size === 1) {
    // One finger lifted mid-pinch: continue as a pan from where it is now.
    const [remaining] = [...pointers.values()];
    if (remaining) panOrigin = { x: remaining.x, y: remaining.y, tx: tx.value, ty: ty.value };
    return;
  }
  if (pointers.size > 0) return;
  pinchStartDistance = 0;
  if (dragged) return;

  // Double-tap toggles. Detected here rather than via `dblclick` so touch and
  // mouse behave identically — `touch-action: none` suppresses the synthesized
  // double-tap on some engines. The clock is performance.now() rather than
  // event.timeStamp because the latter is read-only and so untestable.
  const now = performance.now();
  const isDoubleTap =
    now - lastTap.time < DOUBLE_TAP_MS &&
    Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_SLOP_PX;
  if (isDoubleTap) {
    lastTap = { time: Number.NEGATIVE_INFINITY, x: 0, y: 0 };
    const point = stagePoint(event.clientX, event.clientY);
    if (zoomed.value) reset();
    else zoomAround(DOUBLE_TAP_SCALE, point.x, point.y);
    return;
  }
  lastTap = { time: now, x: event.clientX, y: event.clientY };
}

function onWheel(event: WheelEvent): void {
  const point = stagePoint(event.clientX, event.clientY);
  zoomAround(scale.value * Math.exp(-event.deltaY / 400), point.x, point.y);
}

/* --- overlay lifecycle ---------------------------------------------------- */

let previousFocus: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    event.preventDefault();
    emit('close');
  }
}

onMounted(() => {
  previousFocus = document.activeElement as HTMLElement | null;
  lockBodyScroll();
  document.addEventListener('keydown', onKeydown, true);
  closeButton.value?.focus({ preventScroll: true });
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  unlockBodyScroll();
  previousFocus?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <div
      class="q-figview q-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="alt ? `Abbildung: ${alt}` : 'Abbildung'"
    >
      <div class="q-figview__bar">
        <span class="q-figview__scale" aria-live="polite">{{ Math.round(scale * 100) }} %</span>
        <button v-if="zoomed" type="button" class="q-figview__reset" @click="reset">
          Zurücksetzen
        </button>
        <button
          ref="closeButton"
          type="button"
          class="q-dialog-close q-figview__close"
          aria-label="Schließen"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div ref="stage" class="q-figview__stage" @click.self="emit('close')" @wheel.prevent="onWheel">
        <img
          ref="image"
          class="q-figview__img"
          :src="src"
          :alt="alt ?? ''"
          :style="transform"
          draggable="false"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />
      </div>

      <p class="q-figview__hint">Zum Zoomen ziehen · doppeltippen · Finger spreizen</p>
    </div>
  </Teleport>
</template>

<style scoped>
.q-figview {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  background: var(--q-page);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
}

.q-figview__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
  padding: 10px 14px;
  border-bottom: 1px solid var(--q-border);
  flex: none;
}
.q-figview__scale {
  margin-right: auto;
  font: 700 12px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--q-mut-2);
}
.q-figview__reset {
  border: 1px solid var(--q-btn-border);
  border-radius: 8px;
  background: var(--q-panel);
  color: var(--q-ink);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 12px;
  cursor: pointer;
}
@media (pointer: coarse) {
  .q-figview__reset {
    min-height: 44px;
    padding: 10px 16px;
  }
}

.q-figview__stage {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.q-figview__img {
  max-width: 100%;
  max-height: 100%;
  /* The whole point of this overlay: opt out of the app-wide gesture lock so
   * pinch and pan reach these handlers instead of the browser. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
  background: #fff;
  border-radius: 8px;
  will-change: transform;
}

.q-figview__hint {
  flex: none;
  margin: 0;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  text-align: center;
  font-size: 11px;
  color: var(--q-faint);
}
/* The gesture list is touch vocabulary — pointless next to a mouse. */
@media (hover: hover) and (pointer: fine) {
  .q-figview__hint {
    display: none;
  }
}
</style>
