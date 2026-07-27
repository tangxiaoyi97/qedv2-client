<script setup lang="ts">
/**
 * Official-solution drawer that expands UPWARD from the practice bottom bar
 * (user feedback #2): a max-height transition container composed into the
 * sticky footer ABOVE the nav row. This file is only the expanding body —
 * the parent bottom bar renders the "Lösung" toggle button.
 *
 * Controlled component: the parent owns `open`; Escape asks the parent to
 * close via update:open.
 */
import { computed, ref } from 'vue';
import type { SolutionEntry, ImageFigure } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import ZoomableFigure from '../shared/ZoomableFigure.vue';
import { useAssetResolver } from '../shared/assets.js';

export type SheetVerdict = 'correct' | 'partial' | 'incorrect';

const props = defineProps<{
  solution: SolutionEntry[] | undefined;
  open: boolean;
  /** Constrain the inner content column (e.g. '860px') so the sheet aligns
   *  with the page's content width instead of spanning the whole viewport. */
  contentMaxWidth?: string;
  /**
   * Show the grab handle. False while the user is still answering — there is
   * nothing to reveal yet, and the handle would invite spoiling the question.
   */
  handle?: boolean;
  /** Result of the part, shown at the top of the sheet and used as its tint. */
  verdict?: SheetVerdict;
  verdictLabel?: string;
  verdictPoints?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const resolveAsset = useAssetResolver();

const entries = computed(() => props.solution ?? []);

function imageFigures(entry: SolutionEntry): ImageFigure[] {
  return (entry.figures ?? []).filter((f): f is ImageFigure => f.kind === 'image');
}

/* --- grab handle -----------------------------------------------------------
 * The bottom bar ran out of room for a "Lösung" button on a phone, so the
 * handle IS the control: it stays visible when the sheet is shut, takes a
 * swipe in either direction, and still answers to a plain click for anyone on
 * a mouse or a keyboard.
 */
const HANDLE_SWIPE_PX = 24;

const dragStartY = ref<number | null>(null);
const dragged = ref(false);

function onHandleDown(event: PointerEvent): void {
  (event.target as Element).setPointerCapture?.(event.pointerId);
  dragStartY.value = event.clientY;
  dragged.value = false;
}

function onHandleMove(event: PointerEvent): void {
  if (dragStartY.value == null || dragged.value) return;
  const dy = event.clientY - dragStartY.value;
  if (Math.abs(dy) < HANDLE_SWIPE_PX) return;
  // Up opens, down closes — the sheet grows upward out of the bar.
  dragged.value = true;
  emit('update:open', dy < 0);
}

function onHandleUp(): void {
  dragStartY.value = null;
}

function onHandleClick(): void {
  // A swipe already decided; don't let the trailing click undo it.
  if (dragged.value) {
    dragged.value = false;
    return;
  }
  emit('update:open', !props.open);
}
</script>

<template>
  <div class="q-ssheet-wrap" :class="verdict ? `q-ssheet-wrap--${verdict}` : ''">
    <button
      v-if="handle"
      type="button"
      class="q-ssheet__handle"
      :aria-expanded="open"
      :aria-label="open ? 'Lösung einklappen' : 'Lösung anzeigen'"
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
      @click="onHandleClick"
    >
      <span class="q-ssheet__grip" aria-hidden="true" />
    </button>

    <section
      class="q-ssheet"
      :class="{ 'q-ssheet--open': open }"
      :aria-hidden="!open"
      :inert="!open"
      :tabindex="open ? 0 : -1"
      aria-label="Offizieller Lösungsweg"
      @keydown.esc="emit('update:open', false)"
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
/* The wrapper owns the verdict tint so it covers handle AND sheet as one
 * surface — "did I get this right" readable without opening anything. */
.q-ssheet-wrap {
  background: var(--q-card);
  transition: background var(--q-transition-normal);
}
.q-ssheet-wrap--correct {
  background: var(--q-ok-bg);
}
.q-ssheet-wrap--partial {
  background: var(--q-part-bg);
}
.q-ssheet-wrap--incorrect {
  background: var(--q-err-bg);
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
  background: var(--q-border-3);
  transition: background var(--q-transition-fast), width var(--q-transition-fast);
}
.q-ssheet__handle:hover .q-ssheet__grip,
.q-ssheet__handle:focus-visible .q-ssheet__grip {
  background: var(--q-mut-2);
  width: 52px;
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

.q-ssheet {
  max-height: 0;
  overflow-y: auto;
  transition: max-height 0.3s ease;
  border-bottom: 1px solid transparent;
  outline: none;
}
.q-ssheet--open {
  max-height: min(55vh, 420px);
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
