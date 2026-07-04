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

/**
 * Central assignment. `move` (drag semantics): a right item already used by
 * another row is taken away from it, keeping the mapping one-to-one.
 */
function assign(leftIdx: number, rightIdx: number | null, move: boolean): void {
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
        @dragover.prevent="!review && (dragOverRow = i)"
        @dragleave="dragOverRow === i && (dragOverRow = null)"
        @drop.prevent="onDrop(i, $event)"
      >
        <div class="q-match__main">
          <StateIcon v-if="marks[i]" :state="marks[i]!.correct ? 'correct' : 'incorrect'" :size="20" />
          <span class="q-match__left">
            <RichTextView :nodes="leftItem" inline-only />
          </span>
          <select
            v-if="!review"
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

        <!-- math-safe echo of the chosen right item (answering only) -->
        <div v-if="!review && chosen(i) !== null && hasMath(answer.right[chosen(i)!]!)" class="q-match__echo">
          <span class="q-match__echo-letter">{{ letter(chosen(i)!) }} ·</span>
          <RichTextView :nodes="answer.right[chosen(i)!]" inline-only />
        </div>

        <!-- review: compact comparison — no nested boxes, no dead form controls -->
        <div v-if="review" class="q-match__cmp">
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

    <!-- options pool (chips draggable onto rows on desktop; answering only) -->
    <div v-if="!review" class="q-match__pool">
      <div class="q-match__pool-title">
        Optionen
        <span v-if="!review" class="q-match__pool-hint">ziehen oder per Auswahl zuordnen</span>
      </div>
      <div class="q-match__pool-items">
        <span
          v-for="(rightItem, j) in answer.right"
          :key="j"
          class="q-match__pool-item"
          :class="{
            'q-match__pool-item--used': usedRight.has(j),
            'q-match__pool-item--draggable': !review,
          }"
          :draggable="!review"
          @dragstart="onDragStart(j, $event)"
        >
          <span class="q-match__pool-letter">{{ letter(j) }} ·</span>
          <RichTextView :nodes="rightItem" inline-only />
        </span>
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
