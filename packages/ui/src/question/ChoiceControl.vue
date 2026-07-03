<script setup lang="ts">
/**
 * choice control — "N aus M" multiple choice (prototype 1b/1d/5b).
 *
 * Answering: option cards are toggle buttons (aria-pressed). selectCount===1
 * replaces the selection (radio semantics); selectCount>1 caps at selectCount
 * (clicking an unselected option while full is ignored, aria-disabled hints
 * the cap; clicking a selected option always toggles it off).
 *
 * Review (result set): read-only; per-option marks derive from
 * result.breakdown (ref = option index, note correct-pick|wrong-pick|missed).
 * Never color-only: StateIcon + text label per mark.
 */
import { computed } from 'vue';
import type { BreakdownItem, ChoiceAnswer, GradeResult } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import QChip from '../shared/QChip.vue';

const props = defineProps<{
  answer: ChoiceAnswer;
  modelValue: number[];
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>();

const review = computed(() => props.result != null);
const single = computed(() => props.answer.selectCount === 1);
const full = computed(() => props.modelValue.length >= props.answer.selectCount);

const hint = computed(() => {
  const n = props.answer.selectCount;
  const chosen = props.modelValue.length;
  const what = n === 1 ? 'Wähle genau 1 Antwort' : `Wähle genau ${n} Antworten`;
  return { what, chosen: `${chosen} gewählt` };
});

function letter(i: number): string {
  return String.fromCharCode(65 + i);
}

function isSelected(i: number): boolean {
  return props.modelValue.includes(i);
}

/** Cap hint: unselected options are inert while the selection is full. */
function capBlocked(i: number): boolean {
  return !single.value && full.value && !isSelected(i);
}

interface Mark {
  state: 'correct' | 'incorrect' | 'missed';
  label: string;
}

const marks = computed<(Mark | null)[]>(() => {
  const r = props.result;
  if (!r) return props.answer.options.map(() => null);
  const byRef = new Map<string, BreakdownItem>();
  for (const b of r.breakdown ?? []) byRef.set(b.ref, b);
  return props.answer.options.map((_, i) => {
    const item = byRef.get(String(i));
    // note is authoritative (grader emits it); fall back to deriving it
    const picked = isSelected(i);
    const note =
      item?.note ??
      (item && !item.correct
        ? picked
          ? 'wrong-pick'
          : 'missed'
        : item?.correct && picked
          ? 'correct-pick'
          : undefined);
    if (note === 'correct-pick') return { state: 'correct', label: 'Richtig · gewählt' };
    if (note === 'wrong-pick') return { state: 'incorrect', label: 'Falsch · gewählt' };
    if (note === 'missed') return { state: 'missed', label: 'Richtig · verpasst' };
    return null;
  });
});

function toggle(i: number): void {
  if (review.value) return;
  const selected = isSelected(i);
  if (single.value) {
    // picking replaces the selection; picking the selected one clears it
    emit('update:modelValue', selected ? [] : [i]);
    return;
  }
  if (selected) {
    emit(
      'update:modelValue',
      props.modelValue.filter((x) => x !== i),
    );
    return;
  }
  if (full.value) return; // cap reached — ignore
  emit('update:modelValue', [...props.modelValue, i].sort((a, b) => a - b));
}
</script>

<template>
  <div class="q-choice">
    <div class="q-choice__head">
      <QChip>{{ answer.selectCount }} aus {{ answer.options.length }}</QChip>
      <span v-if="!review" class="q-choice__hint">
        {{ hint.what }} · <b>{{ hint.chosen }}</b>
      </span>
    </div>

    <div class="q-choice__list">
      <button
        v-for="(option, i) in answer.options"
        :key="i"
        type="button"
        class="q-choice__opt"
        :class="{
          'q-choice__opt--selected': !review && isSelected(i),
          'q-choice__opt--capped': !review && capBlocked(i),
          'q-choice__opt--ok': marks[i]?.state === 'correct',
          'q-choice__opt--err': marks[i]?.state === 'incorrect',
          'q-choice__opt--missed': marks[i]?.state === 'missed',
        }"
        :aria-pressed="isSelected(i)"
        :aria-disabled="review || capBlocked(i) || undefined"
        @click="toggle(i)"
      >
        <StateIcon v-if="marks[i]" :state="marks[i]!.state" />
        <span
          v-else
          class="q-choice__box"
          :class="{ 'q-choice__box--radio': single, 'q-choice__box--on': isSelected(i) }"
          aria-hidden="true"
        >
          <template v-if="isSelected(i)">✓</template>
        </span>

        <span class="q-choice__content">
          <RichTextView :nodes="option" inline-only />
        </span>

        <span
          v-if="marks[i]"
          class="q-choice__mark-label"
          :class="`q-choice__mark-label--${marks[i]!.state}`"
        >
          {{ marks[i]!.label }}
        </span>
        <span class="q-choice__letter" aria-hidden="true">{{ letter(i) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.q-choice__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.q-choice__hint {
  font-size: 12px;
  color: var(--q-mut-2);
}
.q-choice__hint b {
  color: var(--q-accent-strong);
}

.q-choice__list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.q-choice__opt {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: var(--q-card);
  color: var(--q-ink);
  font: inherit;
  font-size: 14.5px;
  text-align: left;
  cursor: pointer;
  width: 100%;
  transition: border-color 0.1s ease, background 0.1s ease;
}
.q-choice__opt:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-choice__opt--selected {
  border: 2px solid var(--q-accent);
  background: var(--q-accent-bg);
  padding: 11px 13px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-choice__opt--capped {
  opacity: 0.55;
  cursor: default;
}
.q-choice__opt--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
  padding: 11.5px 13.5px;
  cursor: default;
}
.q-choice__opt--err {
  border: 1.5px solid var(--q-err);
  background: var(--q-err-bg);
  padding: 11.5px 13.5px;
  cursor: default;
}
.q-choice__opt--missed {
  border: 1.5px dashed var(--q-ok);
  background: var(--q-card);
  padding: 11.5px 13.5px;
  cursor: default;
}

.q-choice__box {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1.5px solid var(--q-check-border);
  background: var(--q-card);
  display: inline-grid;
  place-items: center;
  font-size: 13px;
  font-weight: 700;
  flex: none;
  box-sizing: border-box;
}
.q-choice__box--radio {
  border-radius: 50%;
}
.q-choice__box--on {
  border: none;
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
}

.q-choice__content {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-wrap: break-word;
}

.q-choice__mark-label {
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
  flex: none;
}
.q-choice__mark-label--correct,
.q-choice__mark-label--missed {
  color: var(--q-ok);
}
.q-choice__mark-label--incorrect {
  color: var(--q-err);
}

.q-choice__letter {
  font: 600 11px ui-monospace, Menlo, monospace;
  color: var(--q-check-border);
  flex: none;
}
</style>
