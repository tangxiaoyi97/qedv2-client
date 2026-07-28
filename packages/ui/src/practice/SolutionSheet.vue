<script setup lang="ts">
/**
 * Official-solution drawer that expands UPWARD from the practice bottom bar,
 * composed into the sticky footer above the action row.
 *
 * Three detents: shut, the usual reading height, and (swipe only) full
 * screen. Dragging the handle moves the sheet 1:1 with the finger and snaps
 * to the nearest detent on release; clicking is a smooth two-way toggle
 * between shut and the reading height. Full screen is deliberately out of
 * the click cycle — a tap should never swallow the question.
 *
 * Controlled component: the parent owns `detent`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { SolutionEntry, ImageFigure } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import ZoomableFigure from '../shared/ZoomableFigure.vue';
import { useAssetResolver } from '../shared/assets.js';

export type SheetVerdict = 'correct' | 'partial' | 'incorrect';
export type SheetDetent = 'collapsed' | 'default' | 'full';

const props = defineProps<{
  solution: SolutionEntry[] | undefined;
  detent: SheetDetent;
  /** Constrain the inner content column (e.g. '860px') so the sheet aligns
   *  with the page's content width instead of spanning the whole viewport. */
  contentMaxWidth?: string;
  /**
   * Show the grab handle. False while the user is still answering — there is
   * nothing to reveal yet, and the handle would invite spoiling the question.
   */
  handle?: boolean;
  /** Result of the part, shown at the top of the sheet. */
  verdict?: SheetVerdict;
  verdictLabel?: string;
  verdictPoints?: string;
}>();

const emit = defineEmits<{
  (e: 'update:detent', value: SheetDetent): void;
}>();

const resolveAsset = useAssetResolver();

const entries = computed(() => props.solution ?? []);

function imageFigures(entry: SolutionEntry): ImageFigure[] {
  return (entry.figures ?? []).filter((f): f is ImageFigure => f.kind === 'image');
}

/**
 * Once the drawer is shut the grip is the only thing left on screen, so it
 * carries the result as its colour — the app's one remaining "right or
 * wrong" signal at a glance. The word itself rides the accessible name, so
 * the cue is not colour-only for anyone who cannot see it.
 */
const handleLabel = computed(() => {
  const action = props.detent === 'collapsed' ? 'Lösung anzeigen' : 'Lösung einklappen';
  return props.verdictLabel ? `${props.verdictLabel} — ${action}` : action;
});

/* --- detents ---------------------------------------------------------------
 * Heights are resolved in pixels rather than left to CSS, because the drag
 * has to interpolate between them and CSS `min(55vh, 420px)` is not a number
 * this code can reason about.
 */
/** Room left for the practice top bar so full screen never hides it. */
const FULL_SCREEN_RESERVE_PX = 96;
/** Below this a pointer gesture was a tap, and the click handler owns it. */
const TAP_SLOP_PX = 8;

const viewportHeight = ref(typeof window === 'undefined' ? 800 : window.innerHeight);

function readViewport(): void {
  viewportHeight.value = window.innerHeight;
}

const detentHeights = computed<Record<SheetDetent, number>>(() => ({
  collapsed: 0,
  default: Math.min(viewportHeight.value * 0.55, 420),
  full: Math.max(0, viewportHeight.value - FULL_SCREEN_RESERVE_PX),
}));

/* --- drag ------------------------------------------------------------------ */

const dragging = ref(false);
const dragHeight = ref(0);
let dragStartY = 0;
let dragStartHeight = 0;
let moved = false;

/** What the sheet is actually this tall right now. */
const sheetHeight = computed(() =>
  dragging.value ? dragHeight.value : detentHeights.value[props.detent],
);

function nearestDetent(height: number): SheetDetent {
  const entries = Object.entries(detentHeights.value) as [SheetDetent, number][];
  return entries.reduce((best, entry) =>
    Math.abs(entry[1] - height) < Math.abs(best[1] - height) ? entry : best,
  )[0];
}

function onHandleDown(event: PointerEvent): void {
  (event.target as Element).setPointerCapture?.(event.pointerId);
  dragStartY = event.clientY;
  dragStartHeight = detentHeights.value[props.detent];
  dragHeight.value = dragStartHeight;
  moved = false;
}

function onHandleMove(event: PointerEvent): void {
  if (dragStartY === 0 && !moved && !dragging.value) return;
  // Sheet grows upward, so dragging up (negative dy) makes it taller.
  const height = dragStartHeight + (dragStartY - event.clientY);
  if (!moved && Math.abs(dragStartY - event.clientY) < TAP_SLOP_PX) return;
  moved = true;
  dragging.value = true;
  dragHeight.value = Math.max(0, Math.min(detentHeights.value.full, height));
}

function onHandleUp(): void {
  if (!dragging.value) return;
  const snapped = nearestDetent(dragHeight.value);
  dragging.value = false;
  if (snapped !== props.detent) emit('update:detent', snapped);
}

function onHandleClick(): void {
  // The gesture already decided; don't let the trailing click undo it.
  if (moved) {
    moved = false;
    return;
  }
  // Click never reaches full screen — that is the swipe's alone.
  emit('update:detent', props.detent === 'collapsed' ? 'default' : 'collapsed');
}

onMounted(() => window.addEventListener('resize', readViewport));
onBeforeUnmount(() => window.removeEventListener('resize', readViewport));
</script>

<template>
  <div class="q-ssheet-wrap">
    <button
      v-if="handle"
      type="button"
      class="q-ssheet__handle"
      :aria-expanded="detent !== 'collapsed'"
      :aria-label="handleLabel"
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
      @click="onHandleClick"
    >
      <span class="q-ssheet__grip" :class="`q-ssheet__grip--${verdict ?? 'neutral'}`" aria-hidden="true" />
    </button>

    <section
      class="q-ssheet"
      :class="{ 'q-ssheet--dragging': dragging, 'q-ssheet--open': detent !== 'collapsed' }"
      :style="{ height: `${sheetHeight}px` }"
      :aria-hidden="detent === 'collapsed'"
      :inert="detent === 'collapsed'"
      :tabindex="detent === 'collapsed' ? -1 : 0"
      aria-label="Offizieller Lösungsweg"
      @keydown.esc="emit('update:detent', 'collapsed')"
    >
    <div class="q-ssheet__inner" :style="contentMaxWidth ? { maxWidth: contentMaxWidth, margin: '0 auto' } : undefined">
      <!-- The verdict lives here, not in the action row: on a phone it was
           colliding with the Lösung toggle and the primary button. -->
      <div v-if="verdict" class="q-ssheet__verdict" :class="`q-ssheet__verdict--${verdict}`">
        <StateIcon :state="verdict" :size="20" />
        <span class="q-ssheet__verdict-label">{{ verdictLabel }}</span>
        <span v-if="verdictPoints" class="q-ssheet__verdict-points">{{ verdictPoints }}</span>
      </div>

      <div class="q-ssheet__head">
        <span class="q-ssheet__tick" aria-hidden="true"></span>
        <h3 class="q-ssheet__title">Offizieller Lösungsweg</h3>
      </div>
      <p v-if="entries.length === 0" class="q-ssheet__empty">
        Keine offizielle Lösung verfügbar.
      </p>
      <template v-else>
        <template v-for="(entry, i) in entries" :key="i">
          <div v-if="i > 0" class="q-ssheet__divider" role="separator">
            <span class="q-ssheet__divider-label">Alternative</span>
          </div>
          <div class="q-ssheet__entry">
            <div class="q-ssheet__card">
              <RichTextView class="q-ssheet__result" :nodes="entry.result" />
            </div>
            <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-ssheet__figure">
              <ZoomableFigure :src="resolveAsset(fig.src)" :alt="fig.alt" />
            </figure>
            <div v-if="entry.note" class="q-ssheet__note">
              <span class="q-ssheet__note-label">Beurteilungshinweis</span>
              <span class="q-ssheet__note-text">{{ entry.note }}</span>
            </div>
          </div>
        </template>
      </template>
    </div>
    </section>
  </div>
</template>

<style scoped>
.q-ssheet-wrap {
  background: var(--q-card);
}

/* Full-width hit area; the grip is only the visible part of it. */
.q-ssheet__handle {
  display: block;
  width: 100%;
  border: none;
  background: none;
  padding: 9px 0 7px;
  cursor: pointer;
  /* The swipe is ours, not the browser's scroll. */
  touch-action: none;
}
@media (pointer: coarse) {
  .q-ssheet__handle {
    padding: 12px 0 10px;
  }
}
.q-ssheet__grip {
  display: block;
  width: 40px;
  height: 4px;
  margin: 0 auto;
  border-radius: 2px;
  transition: background var(--q-transition-normal), width var(--q-transition-fast),
    height var(--q-transition-fast);
}
.q-ssheet__grip--neutral {
  background: var(--q-border-3);
}
/* A verdict grip is a signal, not just an affordance — give it enough body
 * to read as one from across the screen. */
.q-ssheet__grip--correct,
.q-ssheet__grip--partial,
.q-ssheet__grip--incorrect {
  width: 56px;
  height: 5px;
  border-radius: 3px;
}
.q-ssheet__grip--correct {
  background: var(--q-ok);
}
.q-ssheet__grip--partial {
  background: var(--q-part);
}
.q-ssheet__grip--incorrect {
  background: var(--q-err);
}
/* Hover only recolours the neutral grip; a verdict colour must not be
 * overwritten by pointing at it. */
.q-ssheet__handle:hover .q-ssheet__grip--neutral,
.q-ssheet__handle:focus-visible .q-ssheet__grip--neutral {
  background: var(--q-mut-2);
}
.q-ssheet__handle:hover .q-ssheet__grip,
.q-ssheet__handle:focus-visible .q-ssheet__grip {
  width: 64px;
}

.q-ssheet__verdict {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
  font-weight: 700;
}
.q-ssheet__verdict--correct {
  color: var(--q-ok-ink);
}
.q-ssheet__verdict--partial {
  color: var(--q-part-ink);
}
.q-ssheet__verdict--incorrect {
  color: var(--q-err-ink);
}
.q-ssheet__verdict-points {
  margin-left: auto;
  font: 700 12px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}

/* Height is driven from script so a drag can interpolate between detents;
 * the transition only applies when the finger is NOT on the sheet, which is
 * what makes dragging feel attached and clicking feel eased. */
.q-ssheet {
  height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  transition: height var(--q-transition-normal);
  border-bottom: 1px solid transparent;
  outline: none;
}
.q-ssheet--dragging {
  transition: none;
}
.q-ssheet--open {
  border-bottom: 1px solid var(--q-border);
}
.q-ssheet__inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}
.q-ssheet__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.q-ssheet__tick {
  width: 4px;
  height: 15px;
  border-radius: 2px;
  background: var(--q-accent);
  flex: none;
}
.q-ssheet__title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--q-ink);
}
.q-ssheet__empty {
  margin: 0;
  font-size: 13px;
  color: var(--q-faint);
}
.q-ssheet__entry {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.q-ssheet__card {
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--q-ink-2);
}
.q-ssheet__result {
  overflow-wrap: break-word;
}
.q-ssheet__divider {
  display: flex;
  align-items: center;
  gap: 10px;
}
.q-ssheet__divider::before,
.q-ssheet__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--q-border-2);
}
.q-ssheet__divider-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-ssheet__figure {
  margin: 0;
}
/* Image plate + zoom affordance come from ZoomableFigure. */
.q-ssheet__note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
}
.q-ssheet__note-label {
  font: 700 11px ui-monospace, Menlo, monospace;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.q-ssheet__note-text {
  font: 500 12px/1.6 ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  overflow-wrap: break-word;
}
</style>
