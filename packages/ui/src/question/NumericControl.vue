<script setup lang="ts">
/**
 * numeric control — one text input per blank (prototype 2b).
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
 * de-AT formatted: "Richtig: 4,5 cm (±0,1)".
 */
import { computed, useId } from 'vue';
import type { BreakdownItem, GradeResult, NumericAnswer } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';

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
  const value = (ev.target as HTMLInputElement).value;
  emit('update:modelValue', { ...props.modelValue, [blankId]: value });
}

/** German decimal comma formatting for expected values / tolerances. */
function fmt(n: number): string {
  return n.toLocaleString('de-AT', { maximumFractionDigits: 10 });
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
  <div class="q-numeric">
    <div v-for="blank in answer.blanks" :key="blank.id" class="q-numeric__blank">
      <div class="q-numeric__row">
        <label v-if="multiple" class="q-numeric__label" :for="inputId(blank.id)">
          {{ blank.id }} =
        </label>
        <input
          :id="inputId(blank.id)"
          class="q-numeric__input"
          :class="{
            'q-numeric__input--ok': markOf(blank.id)?.correct === true,
            'q-numeric__input--err': markOf(blank.id)?.correct === false,
          }"
          type="text"
          inputmode="text"
          enterkeyhint="done"
          autocomplete="off"
          spellcheck="false"
          :value="modelValue[blank.id] ?? ''"
          :disabled="review"
          :aria-label="multiple ? undefined : 'Antwort (Zahl)'"
          @input="onInput(blank.id, $event)"
        />
        <span v-if="blank.unit" class="q-numeric__unit">{{ blank.unit }}</span>
        <template v-if="markOf(blank.id)">
          <StateIcon :state="markOf(blank.id)!.correct ? 'correct' : 'incorrect'" :size="20" />
          <span
            class="q-numeric__verdict"
            :class="markOf(blank.id)!.correct ? 'q-numeric__verdict--ok' : 'q-numeric__verdict--err'"
          >
            {{ markOf(blank.id)!.correct ? 'Richtig' : 'Falsch' }}
          </span>
        </template>
      </div>

      <div v-if="markOf(blank.id)?.correct === false" class="q-numeric__expected">
        Richtig: {{ fmt(blank.value) }}{{ blank.unit ? ` ${blank.unit}` : '' }} (±{{ fmt(blank.tol) }})
      </div>
    </div>

    <div v-if="!review" class="q-numeric__hint">Komma oder Punkt erlaubt · Tab wechselt Felder</div>
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
  gap: 10px;
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
  min-width: 64px;
  padding: 10px 12px;
  border: 1px solid var(--q-border-3);
  border-radius: 9px;
  background: var(--q-card);
  color: var(--q-ink);
  font: 500 16px 'Public Sans', system-ui, sans-serif; /* ≥16px: no iOS focus-zoom */
  box-sizing: border-box;
}
.q-numeric__input:focus {
  outline: 2px solid var(--q-accent);
  outline-offset: -1px;
  border-color: var(--q-accent);
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-numeric__input:disabled {
  opacity: 0.9;
}
.q-numeric__input--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
}
.q-numeric__input--err {
  border: 1.5px solid var(--q-err);
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

.q-numeric__hint {
  margin-top: 4px;
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}
@media (pointer: coarse) {
  /* „Tab wechselt Felder" is meaningless on touch keyboards */
  .q-numeric__hint {
    display: none;
  }
}
</style>
