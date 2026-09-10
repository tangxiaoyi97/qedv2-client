<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * Official-solution drawer that expands UPWARD from the practice bottom bar,
 * composed into the sticky footer above the action row.
 *
 * Three detents: shut, the usual reading height, and (swipe only) full
 * screen. Dragging the handle moves the sheet 1:1 with the finger; a short
 * pull or flick advances one detent. Clicking is a smooth two-way toggle
 * between shut and the reading height. Full screen is deliberately out of
 * the click cycle — a tap should never swallow the question.
 *
 * Controlled component: the parent owns `detent`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { isRichTextEmpty, type SolutionEntry, type ImageFigure } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import ChevronDown from '../shared/ChevronDown.vue';
import ZoomableFigure from '../shared/ZoomableFigure.vue';
import { useAssetResolver } from '../shared/assets.js';
import {
  resolveDetentHeights,
  resolveSheetRelease,
  type SheetDetent,
} from './sheet-detents.js';

const { t } = useI18n();

export type SheetVerdict = 'correct' | 'partial' | 'incorrect';
export type { SheetDetent };

const props = withDefaults(defineProps<{
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
  /** Optional visible title makes a collapsed review drawer easy to reopen. */
  handleTitle?: string;
  /** Hide official material while an unanswered first attempt asks for a hint. */
  showSolution?: boolean;
  /**
   * Height to keep clear above the sheet, measured by the shell — its top bar
   * is `56px + env(safe-area-inset-top)`, which no constant in here can know.
   */
  topReserve?: number;
  /** Result of the part, shown at the top of the sheet. */
  verdict?: SheetVerdict;
  verdictLabel?: string;
  verdictPoints?: string;
}>(), { showSolution: true });

const emit = defineEmits<{
  (e: 'update:detent', value: SheetDetent): void;
  /** Live height in px, so the page can reserve exactly that much room. */
  (e: 'update:height', value: number): void;
}>();

const resolveAsset = useAssetResolver();
const sheetId = `q-solution-sheet-${useId()}`;

const entries = computed(() => props.solution ?? []);
const showsSolution = computed(() => props.showSolution !== false);

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
  const subject = props.handleTitle ?? t(showsSolution.value ? 'Lösung' : 'Lernhilfe');
  const action = t(props.detent === 'collapsed' ? '{subject} anzeigen' : '{subject} einklappen', { subject });
  const score = props.handleTitle && props.verdictPoints ? `, ${props.verdictPoints}` : '';
  return props.verdictLabel ? `${props.verdictLabel}${score} — ${action}` : action;
});

/**
 * Full screen turns the header into a result banner: at that size a 4px grip
 * stranded above a separate verdict line reads as two unrelated strips, and
 * the verdict would scroll away with the rest of the content.
 */
// The labelled header keeps its result in the same row at every detent, so
// releasing a drag never adds/removes banner height underneath the animation.
const bannerVerdict = computed(() => (props.handleTitle || props.detent === 'full' ? props.verdict : undefined));

/* --- detents ---------------------------------------------------------------
 * Heights are resolved in pixels rather than left to CSS, because the drag
 * has to interpolate between them and CSS `min(55vh, 420px)` is not a number
 * this code can reason about. The sizing RULES live in sheet-detents.ts so
 * they can be exercised without a layout engine.
 */
/** Below this a pointer gesture was a tap, and the click handler owns it. */
const TAP_SLOP_PX = 8;

const viewportHeight = ref(typeof window === 'undefined' ? 800 : window.innerHeight);
/** Height that shows verdict + title + answer. */
const answerHeight = ref(0);
/** Offset of the grading note, i.e. the first pixel the half detent must not
 *  reach. 0 when the solution carries no note. */
const noteOffset = ref(0);

function readViewport(): void {
  cancelGesture();
  viewportHeight.value = window.innerHeight;
}

const detentHeights = computed(() =>
  resolveDetentHeights({
    viewportHeight: viewportHeight.value,
    answerHeight: answerHeight.value,
    noteOffset: noteOffset.value,
    chromeHeight: chromeHeight.value,
    ...(props.topReserve !== undefined ? { topReserve: props.topReserve } : {}),
  }),
);

/* --- measuring the answer block -------------------------------------------- */

const wrapper = ref<HTMLElement | null>(null);
const handleEl = ref<HTMLButtonElement | null>(null);
const sheetEl = ref<HTMLElement | null>(null);
/** Handle + banner + the parent's action row — everything but the sheet. */
const chromeHeight = ref(0);
const inner = ref<HTMLElement | null>(null);
/**
 * The first entry's answer (result card + figures), without its grading note.
 * Declared inside a v-for, so Vue hands back an array even though the v-if
 * leaves exactly one element in it.
 */
const answerBlock = ref<HTMLElement | HTMLElement[] | null>(null);
/** Custom review content participates in the same measured-height contract. */
const reviewBlock = ref<HTMLElement | null>(null);
/** The first entry's grading note, if it has one. */
const noteBlock = ref<HTMLElement | HTMLElement[] | null>(null);
let contentObserver: ResizeObserver | undefined;

const firstOf = (r: HTMLElement | HTMLElement[] | null): HTMLElement | null =>
  (Array.isArray(r) ? r[0] : r) ?? null;

/**
 * The fixed bottom stack minus the sheet itself. Read off the live DOM rather
 * than assumed, so adding chrome (the verdict banner did exactly this) cannot
 * silently push the stack over the practice top bar at full screen.
 */
function measureChrome(): void {
  if (dragging.value) return;
  const bar = wrapper.value?.parentElement;
  const sheet = sheetEl.value;
  if (!bar || !sheet) return;
  const next = Math.ceil(bar.getBoundingClientRect().height - sheet.getBoundingClientRect().height);
  if (next >= 0 && Math.abs(next - chromeHeight.value) > MEASURE_DEAD_BAND_PX) {
    chromeHeight.value = next;
  }
}

/**
 * Sub-pixel noise is ignored on purpose. The observer watches the same
 * element whose width the sheet's own scrollbar can change, so writing back
 * every measurement lets a one-pixel wobble drive an endless
 * measure → resize → measure loop.
 */
const MEASURE_DEAD_BAND_PX = 2;

function measureAnswer(): void {
  const innerEl = inner.value;
  const blockEl = reviewBlock.value ?? firstOf(answerBlock.value);

  // No official solution → no answer block. The previous part's numbers must
  // not survive into this one, or an empty sheet opens at a height that
  // belonged to a different question.
  if (!blockEl) {
    answerHeight.value = 0;
    noteOffset.value = 0;
    return;
  }
  if (!innerEl || dragging.value) return;
  // At full screen the verdict row moves up into the banner, so it is no
  // longer inside the measured span — measuring here would record a height
  // ~30px short and the default detent would visibly retarget on the way
  // back down. Keep the last good measurement instead.
  if (props.detent === 'full') return;

  const padBottom = parseFloat(getComputedStyle(innerEl).paddingBottom) || 0;
  // Rect deltas rather than offsetTop: the two live in different offset
  // parents once the sheet scrolls.
  const innerTop = innerEl.getBoundingClientRect().top;
  const height = blockEl.getBoundingClientRect().bottom - innerTop;
  if (height <= 0) return;
  const next = Math.ceil(height + padBottom);
  if (Math.abs(next - answerHeight.value) > MEASURE_DEAD_BAND_PX) answerHeight.value = next;

  const noteEl = reviewBlock.value ? null : firstOf(noteBlock.value);
  const noteTop = noteEl ? Math.floor(noteEl.getBoundingClientRect().top - innerTop) : 0;
  if (Math.abs(noteTop - noteOffset.value) > MEASURE_DEAD_BAND_PX) noteOffset.value = noteTop;
}

/* --- drag ------------------------------------------------------------------ */

const dragging = ref(false);
const dragHeight = ref(0);
/** True only between pointerdown and pointerup — a hover must not drag. */
let pointerDown = false;
let activePointerId: number | undefined;
let dragSource: 'handle' | 'content' | undefined;
let dragStartY = 0;
let dragStartHeight = 0;
let moved = false;
let dragSamples: Array<{ height: number; time: number }> = [];
let lastDragY = 0;
let lastMoveTime = 0;
let recentDisplacement = 0;

/** What the sheet is actually this tall right now. */
const sheetHeight = computed(() =>
  dragging.value ? dragHeight.value : detentHeights.value[props.detent],
);

function rememberSample(height: number, time: number): void {
  dragSamples.push({ height, time });
  const cutoff = time - 120;
  while (dragSamples.length > 2 && dragSamples[0]!.time < cutoff) dragSamples.shift();
}

function releaseVelocity(): number {
  const first = dragSamples[0];
  const last = dragSamples[dragSamples.length - 1];
  if (!first || !last) return 0;
  const elapsed = last.time - first.time;
  // Synthetic events and two samples from the same browser frame do not
  // contain a meaningful velocity signal.
  return elapsed >= 8 ? ((last.height - first.height) / elapsed) * 1000 : 0;
}

function beginDrag(y: number, time: number): void {
  dragStartY = y;
  lastDragY = y;
  lastMoveTime = time;
  recentDisplacement = 0;
  // If a spring is interrupted, begin at its visible position rather than at
  // the old logical target. jsdom has no layout, hence the target fallback.
  const liveHeight = sheetEl.value?.getBoundingClientRect().height ?? 0;
  dragStartHeight = liveHeight > 0 ? liveHeight : detentHeights.value[props.detent];
  dragHeight.value = dragStartHeight;
  // Freeze an in-flight snap at its presentation value on pointer-down. The
  // sheet must be grabbable immediately, not only after the finger clears the
  // movement threshold.
  dragging.value = true;
  moved = false;
  dragSamples = [{ height: dragStartHeight, time }];
}

function moveDrag(y: number, time: number): void {
  // Sheet grows upward, so dragging up (negative dy) makes it taller.
  const delta = lastDragY - y;
  if (delta !== 0) {
    recentDisplacement = Math.sign(delta) === Math.sign(recentDisplacement)
      ? recentDisplacement + delta : delta;
    lastMoveTime = time;
    lastDragY = y;
  }
  const height = dragStartHeight + (dragStartY - y);
  if (!moved && Math.abs(dragStartY - y) < TAP_SLOP_PX) return;
  moved = true;
  dragHeight.value = Math.max(0, Math.min(detentHeights.value.full, height));
  rememberSample(dragHeight.value, time);
}

function finishDrag(time: number): void {
  pointerDown = false;
  activePointerId = undefined;
  dragSource = undefined;
  dragStartY = 0;
  if (!dragging.value) return;
  if (!moved) {
    dragging.value = false;
    dragSamples = [];
    void nextTick(measureAnswer);
    return;
  }
  rememberSample(dragHeight.value, time);
  const snapped = resolveSheetRelease({
    detent: props.detent,
    heights: detentHeights.value,
    startHeight: dragStartHeight,
    height: dragHeight.value,
    velocity: releaseVelocity(),
    recentDisplacement,
    idleMs: Math.max(0, time - lastMoveTime),
  });
  dragging.value = false;
  dragSamples = [];
  // Measuring is suppressed while dragging; anything that resized in the
  // meantime (a figure finishing to load) would otherwise stay stale forever.
  void nextTick(measureAnswer);
  void nextTick(measureChrome);
  if (snapped !== props.detent) emit('update:detent', snapped);
}

function onHandleDown(event: PointerEvent): void {
  if (event.isPrimary === false || (event.button !== undefined && event.button !== 0) || dragging.value) return;
  (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  pointerDown = true;
  activePointerId = event.pointerId;
  dragSource = 'handle';
  beginDrag(event.clientY, event.timeStamp);
}

function onHandleMove(event: PointerEvent): void {
  if (!pointerDown || event.pointerId !== activePointerId) return;
  moveDrag(event.clientY, event.timeStamp);
}

function onHandleUp(event: PointerEvent): void {
  if (!pointerDown || event.pointerId !== activePointerId) return;
  moveDrag(event.clientY, event.timeStamp);
  finishDrag(event.timeStamp);
}

function cancelGesture(): void {
  pointerDown = false;
  activePointerId = undefined;
  dragSource = undefined;
  dragStartY = 0;
  dragging.value = false;
  moved = false;
  dragSamples = [];
  contentTouch = undefined;
  void nextTick(measureAnswer);
  void nextTick(measureChrome);
}

function onHandleCancel(event: PointerEvent): void {
  if (dragSource === 'handle' && event.pointerId === activePointerId) cancelGesture();
}

/** Keep the browser's native scrolling and momentum until a finger pulls
 * down beyond the top edge. Only the extra pull belongs to the drawer. */
interface ContentTouch {
  id: number;
  startX: number;
  edgeY: number | null;
  edgeTime: number;
  target: Element;
  claimed: boolean;
}
let contentTouch: ContentTouch | undefined;
let suppressClickUntil = 0;
const INTERACTIVE_TARGET = 'a,button,input,textarea,select,summary,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="checkbox"],[role="radio"],[role="slider"],[role="spinbutton"]';
const textIsSelected = () => window.getSelection()?.isCollapsed === false;

function canPullContent(target: Element): boolean {
  const sheet = sheetEl.value;
  if (!sheet || sheet.scrollTop > 1) return false;
  // A nested scrollable code block/table must retain its own reading gesture.
  for (let element: Element | null = target; element && element !== sheet; element = element.parentElement) {
    if (element.scrollTop > 1 || element.scrollWidth > element.clientWidth + 1) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) return false;
    }
  }
  return true;
}

function onContentTouchStart(event: TouchEvent): void {
  // A fresh tap must not inherit suppression from a preceding drag.
  suppressClickUntil = 0;
  if (dragSource === 'content') cancelGesture();
  contentTouch = undefined;
  if (event.touches.length !== 1 || props.detent === 'collapsed' || dragging.value || textIsSelected()) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(INTERACTIVE_TARGET)) return;
  const touch = event.touches[0]!;
  contentTouch = { id: touch.identifier, startX: touch.clientX,
    edgeY: canPullContent(target) ? touch.clientY : null,
    edgeTime: event.timeStamp, target, claimed: false };
}

function onContentTouchMove(event: TouchEvent): void {
  const gesture = contentTouch;
  if (!gesture) return;
  const touch = Array.from(event.touches).find((point) => point.identifier === gesture.id);
  if (event.touches.length !== 1 || !touch || textIsSelected()) { cancelGesture(); return; }
  if (gesture.claimed) {
    if (!event.cancelable) { cancelGesture(); return; }
    event.preventDefault();
    moveDrag(touch.clientY, event.timeStamp);
    return;
  }
  if (!canPullContent(gesture.target)) { gesture.edgeY = null; return; }
  if (gesture.edgeY === null) {
    gesture.edgeY = touch.clientY;
    gesture.edgeTime = event.timeStamp;
    gesture.startX = touch.clientX;
    return;
  }
  const down = touch.clientY - gesture.edgeY;
  const sideways = Math.abs(touch.clientX - gesture.startX);
  if (sideways > TAP_SLOP_PX && sideways >= Math.abs(down)) { contentTouch = undefined; return; }
  if (down <= 0 || down < sideways * 1.2) return;
  // Reserve a downward edge gesture on its first cancelable movement; waiting
  // until the visual drag threshold would let native scrolling claim it first.
  // If scrolling already owns this gesture, the next pull at the top can claim
  // it. Never fight the browser by rewriting scrollTop during native scrolling.
  if (!event.cancelable) { contentTouch = undefined; return; }
  event.preventDefault();
  gesture.claimed = true;
  dragSource = 'content';
  beginDrag(gesture.edgeY, gesture.edgeTime);
  moveDrag(touch.clientY, event.timeStamp);
}

function onContentTouchEnd(event: TouchEvent): void {
  const gesture = contentTouch;
  if (!gesture) return;
  contentTouch = undefined;
  if (!gesture.claimed) return;
  if (event.cancelable) event.preventDefault();
  if (moved) suppressClickUntil = performance.now() + 400;
  finishDrag(event.timeStamp);
  moved = false; // A content drag must not consume the handle's next click.
}

function onContentClick(event: MouseEvent): void {
  if (event.detail > 0 && performance.now() < suppressClickUntil) {
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function onVisibilityChange(): void {
  if (document.hidden) cancelGesture();
}

function stepDetent(direction: -1 | 1): void {
  const order: readonly SheetDetent[] = ['collapsed', 'default', 'full'];
  const current = order.indexOf(props.detent);
  const target = order[Math.max(0, Math.min(order.length - 1, current + direction))]!;
  if (target !== props.detent) emit('update:detent', target);
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

// The page reserves room for the sheet; it must reserve the REAL height, not
// a copy of the old formula (which is what it was doing).
watch(sheetHeight, (height) => emit('update:height', height), { immediate: true });

onMounted(() => {
  window.addEventListener('resize', readViewport);
  window.addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', onVisibilityChange);
  sheetEl.value?.addEventListener('touchstart', onContentTouchStart, { passive: true });
  sheetEl.value?.addEventListener('touchmove', onContentTouchMove, { passive: false });
  sheetEl.value?.addEventListener('touchend', onContentTouchEnd, { passive: false });
  sheetEl.value?.addEventListener('touchcancel', cancelGesture, { passive: true });
  void nextTick(measureAnswer);
  // Figures load late and change the answer's height under us.
  void nextTick(measureChrome);
  if (typeof ResizeObserver !== 'undefined' && inner.value) {
    contentObserver = new ResizeObserver(() => {
      measureAnswer();
      measureChrome();
    });
    contentObserver.observe(inner.value);
    if (wrapper.value) contentObserver.observe(wrapper.value);
  }
});

watch(
  () => props.detent,
  () => { if (dragging.value || contentTouch) cancelGesture(); },
);

watch(
  () => [props.solution, props.showSolution, props.detent],
  () => void nextTick(measureAnswer),
);

/**
 * The banner only exists at full screen, so the chrome grows by ~64px exactly
 * when the sheet is asked to be tallest. Measuring it only inside
 * measureAnswer (which skips at full) meant the reserve never learned about
 * it and the bar rode over the practice top bar.
 */
watch(
  () => [props.detent, props.verdict, props.handle, props.handleTitle],
  () => void nextTick(measureChrome),
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', readViewport);
  window.removeEventListener('blur', cancelGesture);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  sheetEl.value?.removeEventListener('touchstart', onContentTouchStart);
  sheetEl.value?.removeEventListener('touchmove', onContentTouchMove);
  sheetEl.value?.removeEventListener('touchend', onContentTouchEnd);
  sheetEl.value?.removeEventListener('touchcancel', cancelGesture);
  contentObserver?.disconnect();
});

async function collapseFromKeyboard(): Promise<void> {
  emit('update:detent', 'collapsed');
  await nextTick();
  const handle = handleEl.value
    ?? wrapper.value?.querySelector<HTMLButtonElement>('.q-ssheet__handle');
  handle?.focus({ preventScroll: true });
}
</script>

<template>
  <div ref="wrapper" class="q-ssheet-wrap">
    <!-- Maximised, the grip and the verdict stop being two strips stacked on
         each other and become one banner carrying the result. -->
    <div
      v-if="handle"
      class="q-ssheet__top"
      :class="[
        bannerVerdict ? `q-ssheet__top--${bannerVerdict}` : '',
        detent === 'collapsed' ? 'q-ssheet__top--closed' : '',
      ]"
    >
      <button
        ref="handleEl"
        type="button"
        class="q-ssheet__handle"
        :class="{ 'q-ssheet__handle--labelled': handleTitle }"
        :aria-controls="sheetId"
        :aria-expanded="detent !== 'collapsed'"
        :aria-label="handleLabel"
        @pointerdown="onHandleDown"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleCancel"
        @lostpointercapture="onHandleCancel"
        @keydown.up.prevent="stepDetent(1)"
        @keydown.down.prevent="stepDetent(-1)"
        @click="onHandleClick"
      >
        <span
          class="q-ssheet__grip"
          :class="`q-ssheet__grip--${bannerVerdict ? 'on-banner' : (verdict ?? 'neutral')}`"
          aria-hidden="true"
        />
        <span v-if="handleTitle" class="q-ssheet__handle-caption" :style="contentMaxWidth ? { maxWidth: contentMaxWidth } : undefined">
          <span>{{ handleTitle }}</span>
          <span v-if="verdict" class="q-ssheet__handle-result">
            <StateIcon :state="verdict" :size="16" />
            <span class="q-ssheet__verdict-label">{{ verdictLabel }}</span>
            <span v-if="verdictPoints" class="q-ssheet__verdict-points">{{ verdictPoints }}</span>
          </span>
          <ChevronDown :class="{ 'q-ssheet__handle-chevron--closed': detent === 'collapsed' }" />
        </span>
      </button>
      <div v-if="bannerVerdict && !handleTitle" class="q-ssheet__banner q-reveal" :style="contentMaxWidth ? { maxWidth: contentMaxWidth, margin: '0 auto' } : undefined">
        <StateIcon :state="bannerVerdict" :size="20" />
        <span class="q-ssheet__verdict-label">{{ verdictLabel }}</span>
        <span v-if="verdictPoints" class="q-ssheet__verdict-points">{{ verdictPoints }}</span>
      </div>
    </div>

    <section
      ref="sheetEl"
      :id="sheetId"
      class="q-ssheet"
      :class="{ 'q-ssheet--dragging': dragging, 'q-ssheet--open': detent !== 'collapsed' }"
      :style="{ height: `${sheetHeight}px` }"
      :aria-hidden="detent === 'collapsed'"
      :inert="detent === 'collapsed' ? true : undefined"
      :tabindex="detent === 'collapsed' ? -1 : 0"
      :aria-label="handleTitle ?? t(!showsSolution ? 'Lernhilfe' : $slots.assessment ? 'Lösung und Selbstbewertung' : 'Offizieller Lösungsweg')"
      @keydown.esc.prevent.stop="collapseFromKeyboard"
      @click.capture="onContentClick"
    >
    <div ref="inner" class="q-ssheet__inner" :style="contentMaxWidth ? { maxWidth: contentMaxWidth, margin: '0 auto' } : undefined">
      <!-- The verdict lives here, not in the action row: on a phone it was
           colliding with the Lösung toggle and the primary button. Maximised
           it moves up into the banner instead. -->
      <div
        v-if="verdict && !bannerVerdict"
        class="q-ssheet__verdict q-reveal"
        :class="`q-ssheet__verdict--${verdict}`"
      >
        <StateIcon :state="verdict" :size="20" />
        <span class="q-ssheet__verdict-label">{{ verdictLabel }}</span>
        <span v-if="verdictPoints" class="q-ssheet__verdict-points">{{ verdictPoints }}</span>
      </div>

      <div v-if="$slots.review" ref="reviewBlock" class="q-ssheet__review">
        <slot v-if="showsSolution" name="review" />
        <p v-else class="q-ssheet__empty" role="status">{{ t('Antwort wird gesichert …') }}</p>
      </div>
      <template v-else>
      <div v-if="showsSolution" class="q-ssheet__head">
        <span class="q-ssheet__tick" aria-hidden="true"></span>
        <h3 class="q-ssheet__title">{{ t('Offizieller Lösungsweg') }}</h3>
      </div>
      <p v-if="showsSolution && entries.length === 0" class="q-ssheet__empty">
        {{ t('Keine offizielle Lösung verfügbar.') }}
      </p>
      <template v-else-if="showsSolution">
        <template v-for="(entry, i) in entries" :key="i">
          <div v-if="i > 0" class="q-ssheet__divider" role="separator">
            <span class="q-ssheet__divider-label">{{ t('Alternative') }}</span>
          </div>
          <div class="q-ssheet__entry">
            <!-- Half-open stops at this block's bottom: the answer is
                 complete, the grading note is for whoever opens further. -->
            <div v-if="i === 0" ref="answerBlock" class="q-ssheet__answer">
              <!-- Some entries are figure-only; the card would be an empty
                   framed box under the title. -->
              <div v-if="!isRichTextEmpty(entry.steps)" class="q-ssheet__steps">
                <RichTextView :nodes="entry.steps" />
              </div>
              <div v-if="!isRichTextEmpty(entry.result)" class="q-ssheet__card">
                <RichTextView class="q-ssheet__result" :nodes="entry.result" />
              </div>
              <div
                v-for="(alternative, ai) in entry.alternatives ?? []"
                :key="`${entry.id ?? i}-alternative-${ai}`"
                class="q-ssheet__short-alternative"
              >
                <span>{{ t('Alternative') }}</span>
                <RichTextView :nodes="alternative" />
              </div>
              <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-ssheet__figure">
                <ZoomableFigure :src="resolveAsset(fig.src)" :alt="fig.alt" />
              </figure>
            </div>
            <template v-else>
              <div v-if="!isRichTextEmpty(entry.steps)" class="q-ssheet__steps">
                <RichTextView :nodes="entry.steps" />
              </div>
              <div v-if="!isRichTextEmpty(entry.result)" class="q-ssheet__card">
                <RichTextView class="q-ssheet__result" :nodes="entry.result" />
              </div>
              <div
                v-for="(alternative, ai) in entry.alternatives ?? []"
                :key="`${entry.id ?? i}-alternative-${ai}`"
                class="q-ssheet__short-alternative"
              >
                <span>{{ t('Alternative') }}</span>
                <RichTextView :nodes="alternative" />
              </div>
              <figure v-for="(fig, fi) in imageFigures(entry)" :key="fi" class="q-ssheet__figure">
                <ZoomableFigure :src="resolveAsset(fig.src)" :alt="fig.alt" />
              </figure>
            </template>
            <div
              v-if="entry.note"
              :ref="i === 0 ? (el) => (noteBlock = el as HTMLElement) : undefined"
              class="q-ssheet__note"
            >
              <span class="q-ssheet__note-label">{{ t('Beurteilungshinweis') }}</span>
              <span class="q-ssheet__note-text">{{ entry.note }}</span>
            </div>
          </div>
        </template>
      </template>

      <!--
        Self-assessment lives HERE, under the solution it is judged against,
        instead of in the scrolling question body. It used to sit above the
        fold with the solution in the drawer below it, so grading meant
        remembering the answer from a surface you could not see — and for
        rubric parts the Bewertungsraster repeated the solution verbatim just
        to have something to compare with.
      -->
      <div v-if="$slots.assessment" class="q-ssheet__assessment">
        <slot name="assessment" />
      </div>

      <!--
        AI explanation, below the official solution and clearly separated from
        it. Order matters: the checked answer is read first, the machine's
        commentary second.
      -->
      <slot name="explain" />
      </template>
    </div>
    </section>
  </div>
</template>

<style scoped>
.q-ssheet-wrap {
  background: var(--q-card);
  border-radius: inherit;
  /* Lets the bar's max-height actually squeeze the sheet rather than
   * overflowing it — the JS height below is a target, not a guarantee. */
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Header strip. Neutral normally; maximised it takes the verdict tint and
 * the grip + result read as one banner. */
.q-ssheet__top {
  border-radius: inherit;
  transition: background 240ms ease, border-color 240ms ease;
  border-bottom: 1px solid transparent;
}
/* The verdict ink rides the strip, not the label inside it, so everything on
 * the banner — the grip included — inherits one colour instead of each part
 * having to name it again. */
.q-ssheet__top--correct {
  background: var(--q-ok-bg);
  border-bottom: 1px solid var(--q-ok-border);
  color: var(--q-ok-ink);
}
.q-ssheet__top--partial {
  background: var(--q-part-bg);
  border-bottom: 1px solid var(--q-part-border);
  color: var(--q-part-ink);
}
.q-ssheet__top--incorrect {
  background: var(--q-err-bg);
  border-bottom: 1px solid var(--q-err-border);
  color: var(--q-err-ink);
}
/*
 * Shut, the sheet itself is zero-height, so its own bottom rule has nothing
 * to draw and the grip ends up floating directly on the action row. This is
 * the line that keeps the grip reading as the drawer's lid rather than as a
 * stray mark above the buttons.
 */
.q-ssheet__top--closed {
  border-bottom-color: var(--q-border);
}

.q-ssheet__banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 16px 12px;
  font-size: 15px;
  font-weight: 700;
}

/* Measured block: everything the half-open detent should reveal. */
.q-ssheet__answer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* Full-width hit area; the grip is only the visible part of it. */
.q-ssheet__handle {
  display: block;
  width: 100%;
  border: none;
  background: none;
  /* A button does not inherit colour — the UA gives it `buttontext`. Without
   * this the grip's `currentColor` on the banner resolves to the page ink
   * (near black) instead of the verdict ink the strip is tinted with. */
  color: inherit;
  padding: 9px 0 7px;
  cursor: pointer;
  /* The swipe is ours, not the browser's scroll. */
  touch-action: none;
}
@media (pointer: coarse) {
  .q-ssheet__handle {
    min-height: 44px;
    display: grid;
    place-items: center;
    padding: 0;
  }
}
.q-ssheet__grip {
  --q-grip-x: 1;
  --q-grip-y: 1;
  display: block;
  width: 40px;
  height: 4px;
  margin: 0 auto;
  border-radius: 2px;
  transform: scale(var(--q-grip-x), var(--q-grip-y));
  transition: background-color var(--q-transition-fast), transform var(--q-transition-normal);
}
/*
 * Solid colours, never alpha. Both of these used to be washed-out versions of
 * something else — 18 % black at rest, 35 % ink on the banner — and only
 * reached full strength on hover. On a touch device nothing ever hovers, so
 * the grip stayed permanently faint on exactly the screens it is the only
 * control on.
 */
.q-ssheet__grip--neutral {
  background: var(--q-hint);
}
/* On the tinted banner the grip takes the ink the banner is already written
 * in, so it reads as part of that surface rather than as a second signal. */
.q-ssheet__grip--on-banner {
  background: currentColor;
}
/* A verdict grip is a signal, not just an affordance — give it enough body
 * to read as one from across the screen. */
.q-ssheet__grip--correct,
.q-ssheet__grip--partial,
.q-ssheet__grip--incorrect {
  --q-grip-x: 1.4;
  --q-grip-y: 1.25;
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
.q-ssheet__handle:focus-visible .q-ssheet__grip--neutral {
  background: var(--q-mut-2);
}
.q-ssheet__handle:focus-visible .q-ssheet__grip {
  --q-grip-x: 1.6;
}
@media (hover: hover) and (pointer: fine) {
  .q-ssheet__handle:hover .q-ssheet__grip--neutral { background: var(--q-mut-2); }
  .q-ssheet__handle:hover .q-ssheet__grip { --q-grip-x: 1.6; }
}
.q-ssheet__handle:active .q-ssheet__grip {
  --q-grip-x: 1.72;
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
  min-height: 0;
  flex: 0 1 auto;
  overflow-y: auto;
  /* Without a reserved gutter the scrollbar appears as the sheet grows, the
   * text re-wraps, and the measured answer height stops matching the open
   * one — the content would visibly reflow mid-animation. */
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
  transition: height 240ms cubic-bezier(0.22, 1, 0.36, 1);
  border-bottom: 1px solid transparent;
  outline: none;
}
.q-ssheet--dragging {
  transition: none;
  user-select: none;
}
@media (prefers-reduced-motion: reduce) {
  .q-ssheet, .q-ssheet__top {
    transition: none;
  }
  .q-ssheet__grip {
    transition: none;
  }
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
  height: 18px;
  border-radius: 2px;
  background: var(--q-accent);
  flex: none;
}
.q-ssheet__title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
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
.q-ssheet__steps {
  font-size: 14px;
  line-height: 1.7;
  color: var(--q-ink-2);
  overflow-wrap: break-word;
}
.q-ssheet__result {
  font-weight: 650;
  color: var(--q-ink);
  overflow-wrap: break-word;
}
.q-ssheet__short-alternative {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
  border-left: 2px solid var(--q-border-2);
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--q-ink-2);
}
.q-ssheet__short-alternative > span {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--q-faint);
  text-transform: uppercase;
  letter-spacing: 0.06em;
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
/* Separated from the solution above it: this is where reading stops and
 * judging starts. */
.q-ssheet__assessment {
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--q-border-2);
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

.q-ssheet__review {
  min-width: 0;
  padding: 4px 0 12px;
}
.q-ssheet__handle--labelled {
  user-select: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  min-height: 52px;
  padding: 8px 16px;
}
.q-ssheet__handle-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.5;
}
.q-ssheet__handle-caption > svg {
  flex: none;
}
.q-ssheet__handle-result {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-left: auto;
  font-weight: 600;
}
.q-ssheet__handle-result > svg { flex: none; }
.q-ssheet__handle-result .q-ssheet__verdict-points { margin-left: 2px; white-space: nowrap; }
@media (max-width: 380px) {
  .q-ssheet__handle-result .q-ssheet__verdict-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
}
.q-ssheet__handle-chevron--closed {
  transform: rotate(180deg);
}
.q-ssheet__handle--labelled:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: -3px;
  border-radius: 4px;
}
</style>
