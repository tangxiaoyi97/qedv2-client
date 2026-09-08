<script setup lang="ts">
/**
 * Numeric control — one native text input per blank.
 *
 * Inputs are type="text" with the DEFAULT (full) keyboard: mobile numeric
 * keypads lack the minus sign and math symbols entirely (iOS "decimal" has
 * only digits + comma), so answers like -3 would be untypable. The control
 * passes raw strings through unchanged — locale parsing/normalization is
 * the grader's job. Single blank: full-width input
 * without a label; multiple blanks: "{id} =" label per row. Unit chip after
 * the input when the blank declares one.
 *
 * Review (result set): read-only; per blank ok/err from result.breakdown
 * (ref = blank.id); on error the expected value + tolerance is shown,
 * formatted in the selected UI language.
 */
import { computed, useId } from 'vue';
import type { BreakdownItem, GradeResult, NumericAnswer } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';
import { useI18n } from '../i18n.js';
import { onMathInputKeydown } from './math-input.js';

const { t, formatNumber } = useI18n();


const props = defineProps<{
  answer: NumericAnswer;
  modelValue: Record<string, string>;
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, string>] }>();

const uid = useId();
const review = computed(() => props.result != null);
const multiple = computed(() => props.answer.blanks.length > 1);

function inputId(blankId: string): string {
  return `q-num-${uid}-${blankId}`;
}

function onInput(blankId: string, ev: Event): void {
  if (review.value || (ev as InputEvent).isComposing) return;
  const value = (ev.target as HTMLInputElement).value;
  emit('update:modelValue', { ...props.modelValue, [blankId]: value });
}

/** German decimal comma formatting for expected values / tolerances. */
function fmt(n: number): string {
  return formatNumber(n, { maximumFractionDigits: 10 });
}

const marks = computed<Map<string, BreakdownItem>>(() => {
  const m = new Map<string, BreakdownItem>();
  for (const b of props.result?.breakdown ?? []) m.set(b.ref, b);
  return m;
});

function markOf(blankId: string): BreakdownItem | undefined {
  return review.value ? marks.value.get(blankId) : undefined;
}
</script>

<template>
  <div class="q-numeric" data-answer-fields>
    <div v-for="(blank, index) in answer.blanks" :key="blank.id" class="q-numeric__blank">
      <div class="q-numeric__row">
        <label v-if="multiple" class="q-numeric__label" :for="inputId(blank.id)">
          {{ blank.id }} =
        </label>
        <input
          :id="inputId(blank.id)"
          class="q-numeric__input q-input"
          :class="{
            'q-numeric__input--ok': markOf(blank.id)?.correct === true,
            'q-numeric__input--err': markOf(blank.id)?.correct === false,
          }"
          type="text"
          inputmode="text"
          :enterkeyhint="index < answer.blanks.length - 1 ? 'next' : 'done'"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          :value="modelValue[blank.id] ?? ''"
          :readonly="review"
          :aria-label="multiple ? undefined : t('Antwort (Zahl)')"
          @input="onInput(blank.id, $event)"
          @compositionend="onInput(blank.id, $event)"
          @keydown="onMathInputKeydown"
        />
        <span v-if="blank.unit" class="q-numeric__unit">{{ blank.unit }}</span>
        <template v-if="markOf(blank.id)">
          <StateIcon :state="markOf(blank.id)!.correct ? 'correct' : 'incorrect'" :size="20" />
          <span
            class="q-numeric__verdict q-reveal"
            :class="markOf(blank.id)!.correct ? 'q-numeric__verdict--ok' : 'q-numeric__verdict--err'"
          >
            {{ t(markOf(blank.id)!.correct ? 'Richtig' : 'Falsch') }}
          </span>
        </template>
      </div>

      <div v-if="markOf(blank.id)?.correct === false" class="q-numeric__expected">
        {{ t('Richtig') }}: {{ fmt(blank.value) }}{{ blank.unit ? ` ${blank.unit}` : '' }} (±{{ fmt(blank.tol) }})
      </div>
    </div>

  </div>
</template>

<style scoped>
.q-numeric {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.q-numeric__row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.q-numeric__label {
  flex: none;
  font-size: 14.5px;
  font-style: italic;
  color: var(--q-mut-2);
  overflow-wrap: break-word;
}

.q-numeric__input {
  flex: 1;
  min-width: 96px;
}
.q-numeric__input--ok {
  border-color: var(--q-ok);
  background: var(--q-ok-bg);
}
.q-numeric__input--err {
  border-color: var(--q-err);
  background: var(--q-err-bg);
}

.q-numeric__unit {
  flex: none;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--q-neutral-bg);
  color: var(--q-mut);
  font-size: 12px;
  font-weight: 600;
}

.q-numeric__verdict {
  flex: none;
  font-size: 11.5px;
  font-weight: 700;
  white-space: nowrap;
}
.q-numeric__verdict--ok {
  color: var(--q-ok);
}
.q-numeric__verdict--err {
  color: var(--q-err);
}

.q-numeric__expected {
  margin-top: 7px;
  padding: 7px 11px;
  border: 1.5px dashed var(--q-ok);
  border-radius: 8px;
  background: var(--q-card);
  color: var(--q-ok-ink);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: break-word;
}

</style>
