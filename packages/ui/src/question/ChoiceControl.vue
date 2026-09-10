<script setup lang="ts">
import { useI18n } from '../i18n.js';

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
import { computed, onBeforeUnmount, ref, useId } from 'vue';
import type { BreakdownItem, ChoiceAnswer, GradeResult } from '@qed2/core-logic';
import { richTextToPlain } from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';
import QChip from '../shared/QChip.vue';
import { createOptionActivation } from './option-activation.js';

const { t } = useI18n();

const props = defineProps<{
  answer: ChoiceAnswer;
  modelValue: number[];
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>();

const review = computed(() => props.result != null);
const single = computed(() => props.answer.selectCount === 1);
const full = computed(() => props.modelValue.length >= props.answer.selectCount);
const activation = createOptionActivation();
const controlId = `q-choice-${useId()}`;

const hint = computed(() => {
  const chosen = props.modelValue.length;
  return t('{count} gewählt', { count: chosen });
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
    // Verdict only. Whether the option was picked or missed is already told
    // by the row itself — solid border + filled mark for a pick, dashed for a
    // missed one — so spelling it out again just crowds a narrow row.
    if (note === 'correct-pick') return { state: 'correct', label: t('Richtig') };
    if (note === 'wrong-pick') return { state: 'incorrect', label: t('Falsch') };
    if (note === 'missed') return { state: 'missed', label: t('Richtig') };
    return null;
  });
});

/** Brief nudge when the user taps an option that's blocked by the cap —
 * otherwise the click dies silently and looks like a bug. */
const capNotice = ref(false);
let capNoticeTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(capNoticeTimer));
function nudgeCapNotice(): void {
  capNotice.value = true;
  clearTimeout(capNoticeTimer);
  capNoticeTimer = setTimeout(() => {
    capNotice.value = false;
  }, 1600);
}

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
  if (full.value) {
    nudgeCapNotice();
    return;
  }
  emit('update:modelValue', [...props.modelValue, i].sort((a, b) => a - b));
}

function onOptionClick(i: number, event: MouseEvent): void {
  const action = event.target instanceof Element
    ? event.target.closest('button,a,input,textarea,select,summary,[role="button"]') : null;
  if (action && !action.classList.contains('q-choice__select')) return;
  if (!activation.accepts(event)) return;
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('.q-choice__select')?.focus({ preventScroll: true });
  toggle(i);
}
</script>

<template>
  <div class="q-choice">
    <div class="q-choice__head">
      <QChip>{{ t('{count} aus {total}', { count: answer.selectCount, total: answer.options.length }) }}</QChip>
      <span v-if="!review" class="q-choice__hint" :class="{ 'q-choice__hint--nudge': capNotice }" role="status">
        <template v-if="capNotice">
          <span aria-hidden="true">{{ t('Maximal') }} {{ answer.selectCount }}</span>
          <span class="q-choice__sr-only">{{ t('Maximal {count} — erst eine abwählen', { count: answer.selectCount }) }}</span>
        </template>
        <template v-else>{{ hint }}</template>
      </span>
    </div>

    <div class="q-choice__list">
      <div
        v-for="(option, i) in answer.options"
        :key="i"
        class="q-choice__opt"
        :class="{
          'q-choice__opt--selected': !review && isSelected(i),
          'q-choice__opt--capped': !review && capBlocked(i),
          'q-choice__opt--ok': marks[i]?.state === 'correct',
          'q-choice__opt--err': marks[i]?.state === 'incorrect',
          'q-choice__opt--missed': marks[i]?.state === 'missed',
        }"
        @pointerdown="activation.pointerDown"
        @pointermove="activation.pointerMove"
        @pointerup="activation.pointerMove"
        @pointercancel="activation.pointerCancel"
        @click="onOptionClick(i, $event)"
      >
        <!-- The card-wide select target and image zoom buttons are siblings.
             Rich text stays above this target so selection and panning remain native. -->
        <button
          type="button"
          class="q-choice__select"
          :aria-label="`${letter(i)} · ${richTextToPlain(option)}`"
          :aria-pressed="isSelected(i)"
          :aria-disabled="review || capBlocked(i) || undefined"
          :aria-describedby="marks[i] ? `${controlId}-mark-${i}` : undefined"
        />
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
          :id="`${controlId}-mark-${i}`"
          class="q-choice__mark-label"
          :class="`q-choice__mark-label--${marks[i]!.state}`"
        >
          {{ marks[i]!.label }}
        </span>
        <span class="q-choice__letter" aria-hidden="true">{{ letter(i) }}</span>
      </div>
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
  font-weight: 600;
  color: var(--q-mut-2);
  transition: color 0.15s ease;
}
.q-choice__hint--nudge {
  color: var(--q-err);
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
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--q-border-2);
  border-radius: 11px;
  background: var(--q-card);
  color: var(--q-ink);
  font: inherit;
  font-size: var(--q-font-ui);
  text-align: left;
  cursor: pointer;
  width: 100%;
  /* Short while answering — this is tap feedback. The review states below
   * override it with a slower ease, since that IS the result being shown. */
  transition: border-color 0.1s ease, background 0.1s ease;
}
.q-choice__select {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: inherit;
  background: transparent;
  cursor: inherit;
}
.q-choice__select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.q-choice__opt--selected {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  box-shadow: inset 0 0 0 1px var(--q-accent), 0 0 0 3px var(--q-accent-ring);
}
.q-choice__opt--capped {
  opacity: 0.55;
  cursor: default;
}
.q-choice__opt--ok,
.q-choice__opt--err,
.q-choice__opt--missed {
  transition: border-color var(--q-transition-normal), background-color var(--q-transition-normal);
}
.q-choice__opt--ok {
  border-color: var(--q-ok);
  background: var(--q-ok-bg);
  cursor: default;
}
.q-choice__opt--err {
  border-color: var(--q-err);
  background: var(--q-err-bg);
  cursor: default;
}
.q-choice__opt--missed {
  border-color: var(--q-ok);
  border-style: dashed;
  background: var(--q-card);
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
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  /* The option grows with its text. Only a genuinely wide formula needs
   * horizontal scrolling; making this flex item scroll creates a second,
   * vertical scrollbar for tall KaTeX struts as well. */
  user-select: text;
  -webkit-user-select: text;
}

.q-choice__mark-label,
.q-choice__sr-only {
  /* The check/cross conveys the visible verdict. Keep its spoken label
   * without narrowing the answer and wrapping it again after grading. */
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
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
