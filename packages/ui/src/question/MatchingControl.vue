<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * matching control — assignment via <select> PLUS desktop drag & drop.
 *
 * Selects stay the accessible/mobile-reliable base (prototype 2a); pool
 * chips are additionally draggable onto the left rows (HTML5 DnD). Dropping
 * an already-used option MOVES it (one-to-one stays guaranteed). Keyboard
 * and touch users lose nothing — drag is an enhancement layer only.
 *
 * Each left row pairs the left RichText with a native select whose options
 * are "A · plain-text" projections of the right items (richTextToPlain).
 * The 'Optionen' pool renders all right items with RichTextView and the
 * same A/B/C letters, keeping complete formulas available. Each assignment
 * row shows its choice only in the select, without a duplicate preview.
 * Default one-to-one: a right item used by another row is disabled in the
 * other selects.
 *
 * Classic review replaces the form and pool with a responsive comparison.
 */
import { computed, ref, useId } from 'vue';
import type { GradeResult, MatchingAnswer, RichText } from '@qed2/core-logic';
import { richTextToPlain } from '@qed2/core-logic';
import ChevronDown from '../shared/ChevronDown.vue';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import { onRadioGroupKeydown } from '../shared/radio-group.js';
import { createOptionActivation } from './option-activation.js';
import MatchingReview from './MatchingReview.vue';

const { t } = useI18n();

const props = defineProps<{
  answer: MatchingAnswer;
  modelValue: (number | null)[];
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: (number | null)[]] }>();

const review = computed(() => props.result != null);
const activation = createOptionActivation();
const controlId = `q-match-${useId()}`;

function letter(i: number): string {
  return String.fromCharCode(65 + i);
}

function chosen(leftIdx: number): number | null {
  return props.modelValue[leftIdx] ?? null;
}

/** Right indices already assigned to some row (for one-to-one disabling). */
const usedRight = computed<Set<number>>(() => {
  const s = new Set<number>();
  for (const r of props.modelValue) if (r !== null && r !== undefined) s.add(r);
  return s;
});

function onSelect(leftIdx: number, ev: Event): void {
  const raw = (ev.target as HTMLSelectElement).value;
  assign(leftIdx, raw === '' ? null : Number(raw), false);
}

type MatchOption = { item: RichText; idx: number };
type MatchGroup = { key: string; label: string; leftIndices: number[]; items: MatchOption[] };

const hasCandidateGroups = computed(
  () => Array.isArray(props.answer.candidateGroups) && props.answer.candidateGroups.length > 0,
);

function groupLabel(group: { label?: RichText; leftIndices: number[] }, groupIdx: number): string {
  const explicit = richTextToPlain(group.label ?? []);
  if (explicit) return explicit;
  const leftLabels = group.leftIndices
    .map((leftIdx) => richTextToPlain(props.answer.left[leftIdx] ?? []))
    .filter(Boolean);
  return leftLabels.join(', ') || t('Gruppe {index}', { index: groupIdx + 1 });
}

const groupedRightOptions = computed<MatchGroup[]>(() => {
  const all = props.answer.right.map((item, idx) => ({ item, idx }));
  if (!hasCandidateGroups.value) {
    return [{ key: 'all', label: t('Optionen'), leftIndices: props.answer.left.map((_, idx) => idx), items: all }];
  }
  return props.answer.candidateGroups!.map((group, groupIdx) => {
    const leftIndices = group.leftIndices.filter((idx) => idx >= 0 && idx < props.answer.left.length);
    const items = group.rightIndices
      .filter((idx) => idx >= 0 && idx < props.answer.right.length)
      .map((idx) => ({ item: props.answer.right[idx]!, idx }));
    return {
      key: `${groupIdx}:${leftIndices.join(',')}:${items.map((option) => option.idx).join(',')}`,
      label: groupLabel({ label: group.label, leftIndices }, groupIdx),
      leftIndices,
      items,
    };
  });
});

const groupedOptionMode = computed(() => hasCandidateGroups.value);

const allowedRightsByLeft = computed<Map<number, Set<number>>>(() => {
  const out = new Map<number, Set<number>>();
  for (const group of groupedRightOptions.value) {
    const rightSet = new Set(group.items.map((option) => option.idx));
    for (const leftIdx of group.leftIndices) out.set(leftIdx, rightSet);
  }
  return out;
});

function optionsForLeft(leftIdx: number): MatchOption[] {
  return props.answer.right
    .map((item, idx) => ({ item, idx }))
    .filter((option) => allowedRightsByLeft.value.get(leftIdx)?.has(option.idx) ?? true);
}

function canAssign(leftIdx: number, rightIdx: number | null): boolean {
  if (rightIdx === null) return true;
  return allowedRightsByLeft.value.get(leftIdx)?.has(rightIdx) ?? true;
}

/**
 * Central assignment. `move` (drag semantics): a right item already used by
 * another row is taken away from it, keeping the mapping one-to-one.
 */
function assign(leftIdx: number, rightIdx: number | null, move: boolean): void {
  if (!canAssign(leftIdx, rightIdx)) return;
  const next: (number | null)[] = [];
  for (let i = 0; i < props.answer.left.length; i++) next.push(props.modelValue[i] ?? null);
  if (move && rightIdx !== null) {
    for (let i = 0; i < next.length; i++) if (next[i] === rightIdx) next[i] = null;
  }
  next[leftIdx] = rightIdx;
  emit('update:modelValue', next);
}

function onOptionClick(leftIdx: number, rightIdx: number, event: MouseEvent): void {
  const action = event.target instanceof Element
    ? event.target.closest('button,a,input,textarea,select,summary,[role="button"]') : null;
  if (action && !action.classList.contains('q-match__option-select')) return;
  if (!activation.accepts(event)) return;
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('.q-match__option-select')?.focus({ preventScroll: true });
  if (!review.value) assign(leftIdx, chosen(leftIdx) === rightIdx ? null : rightIdx, false);
}

/* --- drag & drop enhancement (desktop) --- */
const dragOverRow = ref<number | null>(null);

function onDragStart(rightIdx: number, ev: DragEvent): void {
  if (review.value || !ev.dataTransfer) return;
  ev.dataTransfer.setData('text/plain', String(rightIdx));
  ev.dataTransfer.effectAllowed = 'move';
}

function onDrop(leftIdx: number, ev: DragEvent): void {
  dragOverRow.value = null;
  if (review.value) return;
  const raw = ev.dataTransfer?.getData('text/plain') ?? '';
  const rightIdx = Number(raw);
  if (!Number.isInteger(rightIdx) || rightIdx < 0 || rightIdx >= props.answer.right.length) return;
  assign(leftIdx, rightIdx, true);
}

/** Expected right index per left index (from answer.pairs). */
const expectedRight = computed<Map<number, number>>(() => new Map(props.answer.pairs));

/**
 * Grouped ("Lückentext") review state per option card — mirrors
 * ChoiceControl's visual language: the gap behaves like an independent
 * single-choice question, so feedback lands ON the options themselves.
 */
type GapOptionState = 'on' | 'ok' | 'err' | 'missed' | null;

function gapOptionState(leftIdx: number, rightIdx: number): GapOptionState {
  const isChosen = chosen(leftIdx) === rightIdx;
  if (!review.value) return isChosen ? 'on' : null;
  const expected = expectedRight.value.get(leftIdx);
  if (isChosen) return rightIdx === expected ? 'ok' : 'err';
  if (rightIdx === expected) return 'missed';
  return null;
}
</script>

<template>
  <div class="q-match">
    <MatchingReview v-if="result && !groupedOptionMode" :answer="answer" :model-value="modelValue" :result="result" />
    <!-- Grouped review keeps feedback on the options. Repeating it in the
         heading would both crowd the group and move its label sideways. -->
    <div v-else class="q-match__rows" :class="{ 'q-match__rows--grouped': groupedOptionMode }">
      <div
        v-for="(leftItem, i) in answer.left"
        :key="i"
        class="q-match__row"
        :class="{
          'q-match__row--dragover': dragOverRow === i,
        }"
        @dragover.prevent="!review && !groupedOptionMode && (dragOverRow = i)"
        @dragleave="dragOverRow === i && (dragOverRow = null)"
        @drop.prevent="onDrop(i, $event)"
      >
        <div class="q-match__main">
          <span class="q-match__left">
            <RichTextView :nodes="leftItem" inline-only />
          </span>
          <span v-if="!review && !groupedOptionMode" class="q-match__select-wrap">
            <select
              class="q-match__select"
              :class="{ 'q-match__select--assigned': chosen(i) !== null }"
              :value="chosen(i) === null ? '' : String(chosen(i))"
              :disabled="review"
              :aria-label="t('Zuordnung für „{text}“', { text: richTextToPlain(leftItem) })"
              @change="onSelect(i, $event)"
            >
              <option value="">{{ t('zuordnen …') }}</option>
              <option
                v-for="(rightItem, j) in answer.right"
                :key="j"
                :value="String(j)"
                :disabled="j !== chosen(i) && usedRight.has(j)"
              >
                {{ letter(j) }} · {{ richTextToPlain(rightItem) }}
              </option>
            </select>
            <ChevronDown class="q-match__select-arrow" />
          </span>
        </div>

        <!-- grouped ("Lückentext") mode: the gap IS a single-choice question —
             option cards like ChoiceControl, feedback in place, no pool. -->
        <div v-if="groupedOptionMode" class="q-match__inline-choices" role="radiogroup" :aria-label="t('Optionen für {text}', { text: richTextToPlain(leftItem) })" @keydown="onRadioGroupKeydown">
          <div
            v-for="option in optionsForLeft(i)"
            :key="option.idx"
            class="q-match__inline-choice"
            :class="{
              'q-match__inline-choice--on': gapOptionState(i, option.idx) === 'on',
              'q-match__inline-choice--ok': gapOptionState(i, option.idx) === 'ok',
              'q-match__inline-choice--err': gapOptionState(i, option.idx) === 'err',
              'q-match__inline-choice--missed': gapOptionState(i, option.idx) === 'missed',
              'q-match__inline-choice--review': review,
            }"
            @pointerdown="activation.pointerDown"
            @pointermove="activation.pointerMove"
            @pointerup="activation.pointerMove"
            @pointercancel="activation.pointerCancel"
            @click="onOptionClick(i, option.idx, $event)"
          >
            <button
              type="button"
              class="q-match__option-select"
              role="radio"
              :aria-label="`${letter(option.idx)} · ${richTextToPlain(option.item)}`"
              :aria-checked="chosen(i) === option.idx"
              :aria-disabled="review || undefined"
              :aria-describedby="review && gapOptionState(i, option.idx) ? `${controlId}-mark-${i}-${option.idx}` : undefined"
            />
            <StateIcon
              v-if="review && gapOptionState(i, option.idx) === 'ok'"
              state="correct"
              :size="20"
            />
            <StateIcon
              v-else-if="review && gapOptionState(i, option.idx) === 'err'"
              state="incorrect"
              :size="20"
            />
            <StateIcon
              v-else-if="review && gapOptionState(i, option.idx) === 'missed'"
              state="missed"
              :size="20"
            />
            <span
              v-else
              class="q-match__oc-radio"
              :class="{ 'q-match__oc-radio--on': chosen(i) === option.idx }"
              aria-hidden="true"
            />
            <span class="q-match__oc-content"><RichTextView :nodes="option.item" inline-only /></span>
            <span
              v-if="review && gapOptionState(i, option.idx)"
              :id="`${controlId}-mark-${i}-${option.idx}`"
              class="q-match__oc-label"
              :class="`q-match__oc-label--${gapOptionState(i, option.idx)}`"
            >
              <!-- verdict only; picked vs. missed is already in the row style -->
              {{ t(gapOptionState(i, option.idx) === 'err' ? 'Falsch' : 'Richtig') }}
            </span>
            <span class="q-match__pool-letter">{{ letter(option.idx) }} ·</span>
          </div>
        </div>
      </div>
    </div>

    <!-- options pool (classic mode only — grouped mode's options live inline) -->
    <div v-if="!review && !groupedOptionMode" class="q-match__pool">
      <div class="q-match__pool-title">
        {{ t('Optionen') }}
        <span class="q-match__pool-hint q-match__pool-hint--fine">{{ t('Ziehen / auswählen') }}</span>
        <span class="q-match__pool-hint q-match__pool-hint--coarse">{{ t('Auswählen') }}</span>
      </div>
      <div class="q-match__pool-items">
        <div
          v-for="group in groupedRightOptions"
          :key="group.key"
          class="q-match__pool-group"
        >
          <div v-if="groupedOptionMode" class="q-match__pool-group-title">{{ group.label }}</div>
          <span
            v-for="option in group.items"
            :key="option.idx"
            class="q-match__pool-item"
            :class="{
              'q-match__pool-item--used': usedRight.has(option.idx),
              'q-match__pool-item--draggable': !review,
            }"
            :draggable="!review"
            @dragstart="onDragStart(option.idx, $event)"
          >
            <span class="q-match__pool-letter">{{ letter(option.idx) }} ·</span>
            <RichTextView :nodes="option.item" inline-only />
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-match__rows {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
/* grouped ("2 aus 3" / Lückentext) mode: gaps sit side by side once the
   screen is wide enough — each gap behaves like its own mini question, so
   there is no reason to force them into a single column. */
@media (min-width: 640px) {
  .q-match__rows--grouped {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    align-items: start;
    gap: 12px;
  }
}

.q-match__row {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
  transition: border-color 0.3s ease, background 0.3s ease, color 0.3s ease;
}
.q-match__row--dragover {
  border-color: var(--q-accent);
  border-style: dashed;
  background: var(--q-accent-bg);
  box-shadow: 0 0 0 1px var(--q-accent);
}

.q-match__main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.q-match__left {
  flex: 1;
  min-width: 0;
  font-size: 14.5px;
  overflow-wrap: anywhere;
}

/* flat, underline-style dropdown — no boxed/nested-card look; the row
   itself is already the only "box" on screen. */
.q-match__select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  max-width: 55%;
}
.q-match__select {
  width: 100%;
  max-width: 100%;
  padding: 4px var(--q-control-chevron-padding-end) 4px 2px;
  border: none;
  border-bottom: 1.5px solid var(--q-border-3);
  border-radius: 0;
  background: transparent;
  color: var(--q-mut-2);
  font: 700 16px 'Public Sans', system-ui, sans-serif; /* ≥16px: no iOS focus-zoom */
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (pointer: coarse) {
  .q-match__select-wrap {
    min-height: 44px;
  }
  .q-match__select {
    min-height: 44px;
  }
}
.q-match__select--assigned {
  border-bottom: 1.5px solid var(--q-accent);
  color: var(--q-accent-strong);
}
.q-match__select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.q-match__select:disabled {
  cursor: default;
  opacity: 0.8;
}
.q-match__select-arrow {
  position: absolute;
  right: var(--q-control-chevron-inset);
  top: 50%;
  transform: translateY(-50%);
  font-size: 16px;
  line-height: 1;
  color: var(--q-faint);
  pointer-events: none;
}

 /* grouped ("Lückentext") mode — option cards, ChoiceControl's language */
.q-match__inline-choices {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-match__inline-choice {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 400 14px 'Public Sans', system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.1s ease, background 0.1s ease;
}
@media (hover: hover) and (pointer: fine) {
  .q-match__inline-choice:hover {
    border-color: var(--q-accent);
  }
}
.q-match__option-select {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: inherit;
  background: transparent;
  cursor: inherit;
}
.q-match__option-select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-match__inline-choice--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  box-shadow: inset 0 0 0 1px var(--q-accent), 0 0 0 3px var(--q-accent-ring);
}
.q-match__inline-choice--ok {
  border-color: var(--q-ok);
  background: var(--q-ok-bg);
  cursor: default;
}
.q-match__inline-choice--err {
  border-color: var(--q-err);
  background: var(--q-err-bg);
  cursor: default;
}
.q-match__inline-choice--missed {
  border-color: var(--q-ok);
  border-style: dashed;
  cursor: default;
}
.q-match__inline-choice--review {
  cursor: default;
}
.q-match__oc-radio {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1.5px solid var(--q-check-border);
  background: var(--q-card);
  flex: none;
  box-sizing: border-box;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}
.q-match__oc-radio--on {
  border: 6px solid var(--q-accent-strong);
}
.q-match__oc-content {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
}
.q-match__oc-label {
  /* Option glyphs carry the visible verdict; its accessible text must not
   * take width away from the answer when the result arrives. */
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.q-match__oc-label--ok,
.q-match__oc-label--missed {
  color: var(--q-ok);
}
.q-match__oc-label--err {
  color: var(--q-err);
}
.q-match__inline-choice .q-match__pool-letter {
  margin-right: 0;
  color: var(--q-check-border);
}

.q-match__pool-letter {
  font: 600 11px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  margin-right: 4px;
}

.q-match__pool {
  margin-top: 14px;
  padding: 12px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
}
.q-match__pool-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin-bottom: 8px;
}
.q-match__pool-items {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.q-match__pool-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  min-width: 0;
}
.q-match__pool-group-title {
  font: 800 12px ui-monospace, Menlo, monospace;
  color: var(--q-accent-strong);
  padding: 0 2px;
}
.q-match__pool-item {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 7px;
  background: var(--q-card);
  border: 1px solid var(--q-border-2);
  font-size: 12.5px;
  font-weight: 600;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-wrap: anywhere;
}
.q-match__pool-item > :deep(.q-richtext) {
  min-width: 0;
}
.q-match__pool-item > .q-match__pool-letter {
  flex: none;
}
.q-match__pool-item--used {
  background: var(--q-panel-2);
  border-color: transparent;
  /* The pool is also the formula reference for assigned items. Keep its
   * notation readable instead of striking through numbers and operators. */
}
.q-match__pool-item--draggable {
  cursor: grab;
}
.q-match__pool-item--draggable:active {
  cursor: grabbing;
}
.q-match__pool-hint {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  color: var(--q-hint);
  margin-left: 8px;
}
.q-match__pool-hint--coarse {
  display: none;
}
@media (pointer: coarse) {
  .q-match__pool-hint--fine {
    display: none;
  }
  .q-match__pool-hint--coarse {
    display: inline;
  }
}
</style>
