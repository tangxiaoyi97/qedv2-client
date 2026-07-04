<script setup lang="ts">
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
 * Right items may contain math, so the chosen item is re-rendered below the
 * row through RichTextView whenever it contains a math node, and an
 * 'Optionen' pool panel renders ALL right items with RichTextView, prefixed
 * with the same A/B/C letters — the letters make select-option ↔ pool-entry
 * unambiguous even with formulas. Default one-to-one: a right item used by
 * another row is disabled in the other selects.
 *
 * Review (result set): the form controls and the pool disappear — each row
 * collapses to the state icon + compact comparison lines (Gewählt/Richtig),
 * so the feedback stays scannable even with long German option texts.
 */
import { computed, ref } from 'vue';
import type { BreakdownItem, GradeResult, MatchingAnswer, RichText } from '@qed2/core-logic';
import { richTextToPlain } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';

const props = defineProps<{
  answer: MatchingAnswer;
  modelValue: (number | null)[];
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: (number | null)[]] }>();

const review = computed(() => props.result != null);

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

function hasMath(rt: RichText): boolean {
  return rt.some((n) => n.t === 'math');
}

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
  return leftLabels.join(', ') || `Gruppe ${groupIdx + 1}`;
}

const groupedRightOptions = computed<MatchGroup[]>(() => {
  const all = props.answer.right.map((item, idx) => ({ item, idx }));
  if (!hasCandidateGroups.value) {
    return [{ key: 'all', label: 'Optionen', leftIndices: props.answer.left.map((_, idx) => idx), items: all }];
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

/** result.breakdown by left index. */
const marks = computed<(BreakdownItem | null)[]>(() => {
  const r = props.result;
  if (!r) return props.answer.left.map(() => null);
  const byRef = new Map<string, BreakdownItem>();
  for (const b of r.breakdown ?? []) byRef.set(b.ref, b);
  return props.answer.left.map((_, i) => byRef.get(String(i)) ?? null);
});

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
    <div class="q-match__rows">
      <div
        v-for="(leftItem, i) in answer.left"
        :key="i"
        class="q-match__row"
        :class="{
          'q-match__row--ok': marks[i]?.correct === true,
          'q-match__row--err': marks[i]?.correct === false,
          'q-match__row--dragover': dragOverRow === i,
        }"
        @dragover.prevent="!review && !groupedOptionMode && (dragOverRow = i)"
        @dragleave="dragOverRow === i && (dragOverRow = null)"
        @drop.prevent="onDrop(i, $event)"
      >
        <div class="q-match__main">
          <StateIcon v-if="marks[i]" :state="marks[i]!.correct ? 'correct' : 'incorrect'" :size="20" />
          <span class="q-match__left">
            <RichTextView :nodes="leftItem" inline-only />
          </span>
          <select
            v-if="!review && !groupedOptionMode"
            class="q-match__select"
            :class="{ 'q-match__select--assigned': chosen(i) !== null }"
            :value="chosen(i) === null ? '' : String(chosen(i))"
            :disabled="review"
            :aria-label="`Zuordnung für „${richTextToPlain(leftItem)}“`"
            @change="onSelect(i, $event)"
          >
            <option value="">zuordnen …</option>
            <option
              v-for="(rightItem, j) in answer.right"
              :key="j"
              :value="String(j)"
              :disabled="j !== chosen(i) && usedRight.has(j)"
            >
              {{ letter(j) }} · {{ richTextToPlain(rightItem) }}
            </option>
          </select>
        </div>

        <!-- grouped ("Lückentext") mode: the gap IS a single-choice question —
             option cards like ChoiceControl, feedback in place, no pool. -->
        <div v-if="groupedOptionMode" class="q-match__inline-choices" role="radiogroup" :aria-label="`Optionen für ${richTextToPlain(leftItem)}`">
          <button
            v-for="option in optionsForLeft(i)"
            :key="option.idx"
            type="button"
            class="q-match__inline-choice"
            :class="{
              'q-match__inline-choice--on': gapOptionState(i, option.idx) === 'on',
              'q-match__inline-choice--ok': gapOptionState(i, option.idx) === 'ok',
              'q-match__inline-choice--err': gapOptionState(i, option.idx) === 'err',
              'q-match__inline-choice--missed': gapOptionState(i, option.idx) === 'missed',
            }"
            role="radio"
            :aria-checked="chosen(i) === option.idx"
            :aria-disabled="review || undefined"
            @click="!review && assign(i, chosen(i) === option.idx ? null : option.idx, false)"
          >
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
              class="q-match__oc-label"
              :class="`q-match__oc-label--${gapOptionState(i, option.idx)}`"
            >
              {{ gapOptionState(i, option.idx) === 'ok' ? 'Richtig · gewählt' : gapOptionState(i, option.idx) === 'err' ? 'Falsch · gewählt' : 'Richtig' }}
            </span>
            <span class="q-match__pool-letter">{{ letter(option.idx) }} ·</span>
          </button>
        </div>

        <!-- math-safe echo of the chosen right item (classic mode, answering only) -->
        <div v-if="!review && !groupedOptionMode && chosen(i) !== null && hasMath(answer.right[chosen(i)!]!)" class="q-match__echo">
          <span class="q-match__echo-letter">{{ letter(chosen(i)!) }} ·</span>
          <RichTextView :nodes="answer.right[chosen(i)!]" inline-only />
        </div>

        <!-- review (classic mode): compact comparison lines -->
        <div v-if="review && !groupedOptionMode" class="q-match__cmp">
          <div v-if="marks[i]?.correct && chosen(i) !== null" class="q-match__cmp-line q-match__cmp-line--ok">
            <span class="q-match__cmp-letter">{{ letter(chosen(i)!) }}</span>
            <RichTextView :nodes="answer.right[chosen(i)!]" inline-only />
          </div>
          <template v-else-if="marks[i] && !marks[i]!.correct">
            <div v-if="chosen(i) !== null" class="q-match__cmp-line q-match__cmp-line--user">
              <span class="q-match__cmp-tag">Gewählt</span>
              <span class="q-match__cmp-letter">{{ letter(chosen(i)!) }}</span>
              <RichTextView :nodes="answer.right[chosen(i)!]" inline-only />
            </div>
            <div v-if="expectedRight.has(i)" class="q-match__cmp-line q-match__cmp-line--ok">
              <span class="q-match__cmp-tag q-match__cmp-tag--ok">Richtig</span>
              <span class="q-match__cmp-letter">{{ letter(expectedRight.get(i)!) }}</span>
              <RichTextView :nodes="answer.right[expectedRight.get(i)!]" inline-only />
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- options pool (classic mode only — grouped mode's options live inline) -->
    <div v-if="!review && !groupedOptionMode" class="q-match__pool">
      <div class="q-match__pool-title">
        Optionen
        <span v-if="!review" class="q-match__pool-hint">ziehen oder per Auswahl zuordnen</span>
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

.q-match__row {
  padding: 10px 12px;
  border: 1px solid var(--q-border-2);
  border-radius: 10px;
  background: var(--q-card);
}
.q-match__row--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
}
.q-match__row--err {
  border: 1.5px solid var(--q-err);
  background: var(--q-err-bg);
}
.q-match__row--dragover {
  border: 2px dashed var(--q-accent);
  background: var(--q-accent-bg);
  padding: 9px 11px;
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
  overflow-x: auto;
  overflow-wrap: break-word;
}

.q-match__select {
  flex: none;
  max-width: 55%;
  padding: 6px 9px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  color: var(--q-mut-2);
  font: 600 13px 'Public Sans', system-ui, sans-serif;
  cursor: pointer;
}
.q-match__select--assigned {
  border: 2px solid var(--q-accent);
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
  padding: 5px 8px;
}
.q-match__select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 0;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-match__select:disabled {
  cursor: default;
  opacity: 0.8;
}

 /* grouped ("Lückentext") mode — option cards, ChoiceControl's language */
.q-match__inline-choices {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-match__inline-choice {
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
.q-match__inline-choice:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-match__inline-choice--on {
  border: 2px solid var(--q-accent);
  background: var(--q-accent-bg);
  padding: 11px 13px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-match__inline-choice--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
  padding: 11.5px 13.5px;
  cursor: default;
}
.q-match__inline-choice--err {
  border: 1.5px solid var(--q-err);
  background: var(--q-err-bg);
  padding: 11.5px 13.5px;
  cursor: default;
}
.q-match__inline-choice--missed {
  border: 1.5px dashed var(--q-ok);
  padding: 11.5px 13.5px;
  cursor: default;
}
.q-match__inline-choice[aria-disabled='true'] {
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
}
.q-match__oc-radio--on {
  border: 6px solid var(--q-accent-strong);
}
.q-match__oc-content {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-wrap: break-word;
}
.q-match__oc-label {
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
  flex: none;
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

.q-match__echo {
  margin-top: 8px;
  padding: 7px 10px;
  border: 1px solid var(--q-border-soft);
  border-radius: 8px;
  background: var(--q-panel);
  font-size: 13.5px;
  overflow-x: auto;
}
.q-match__echo-letter,
.q-match__pool-letter {
  font: 600 11px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  margin-right: 4px;
}

.q-match__cmp {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-left: 30px; /* align under the left item, past the state icon */
}
.q-match__cmp-line {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 13px;
  min-width: 0;
}
.q-match__cmp-line--user {
  color: var(--q-mut-2);
}
.q-match__cmp-line--ok {
  color: var(--q-ink);
}
.q-match__cmp-tag {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  width: 52px;
  flex: none;
}
.q-match__cmp-tag--ok {
  color: var(--q-ok);
}
.q-match__cmp-letter {
  font: 700 11px ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  flex: none;
}
.q-match__cmp-line--ok .q-match__cmp-letter {
  color: var(--q-ok);
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
  overflow-x: auto;
}
.q-match__pool-item--used {
  background: var(--q-panel-2);
  border-color: transparent;
  opacity: 0.5;
  text-decoration: line-through;
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
</style>
