<script setup lang="ts">
/**
 * interval control — bounds + open/closed toggles (prototype 2c).
 * Empty bound (or ∞ notation) = unbounded. Review compares against the
 * canonical interval notation.
 */
import { computed } from 'vue';
import type { GradeResult, IntervalAnswer } from '@qed2/core-logic';
import type { IntervalSubmission } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';

const props = defineProps<{
  answer: IntervalAnswer;
  modelValue: IntervalSubmission;
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: IntervalSubmission] }>();

const review = computed(() => props.result != null);

function patch(p: Partial<IntervalSubmission>): void {
  if (review.value) return;
  emit('update:modelValue', { ...props.modelValue, ...p });
}

function fmtNum(n: number): string {
  return n.toLocaleString('de-AT', { maximumFractionDigits: 6 });
}

/** Preview text of a bound: raw input, or ∞ glyphs when empty/inf. */
function boundText(raw: string, side: 'lower' | 'upper'): string {
  const t = raw.trim().toLowerCase();
  if (t === '' || t === 'inf' || t === '-inf' || t === 'oo' || t === '-oo' || t === '∞' || t === '-∞') {
    return side === 'lower' ? '−∞' : '∞';
  }
  return raw.trim();
}

const preview = computed(() => {
  const m = props.modelValue;
  const lb = m.lowerClosed && !isUnbounded(m.lower) ? '[' : '(';
  const ub = m.upperClosed && !isUnbounded(m.upper) ? ']' : ')';
  return `${lb} ${boundText(m.lower, 'lower')} ; ${boundText(m.upper, 'upper')} ${ub}`;
});

function isUnbounded(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t === '' || t === 'inf' || t === '-inf' || t === 'oo' || t === '-oo' || t === '∞' || t === '-∞';
}

const correctNotation = computed(() => {
  const a = props.answer;
  const lb = a.lower !== null && a.lowerClosed ? '[' : '(';
  const ub = a.upper !== null && a.upperClosed ? ']' : ')';
  const lo = a.lower === null ? '−∞' : fmtNum(a.lower);
  const hi = a.upper === null ? '∞' : fmtNum(a.upper);
  return `${lb} ${lo} ; ${hi} ${ub}`;
});
</script>

<template>
  <div class="q-interval">
    <div class="q-interval__row" :class="{ 'q-interval__row--review': review }">
      <div class="q-interval__toggle-col">
        <div class="q-interval__toggle" role="group" aria-label="Untere Grenze offen oder geschlossen">
          <button
            type="button"
            class="q-interval__bracket"
            :class="{ 'q-interval__bracket--on': !modelValue.lowerClosed }"
            :disabled="review"
            @click="patch({ lowerClosed: false })"
          >
            (
          </button>
          <button
            type="button"
            class="q-interval__bracket"
            :class="{ 'q-interval__bracket--on': modelValue.lowerClosed }"
            :disabled="review"
            @click="patch({ lowerClosed: true })"
          >
            [
          </button>
        </div>
        <span class="q-interval__toggle-label">{{ modelValue.lowerClosed ? 'geschl.' : 'offen' }}</span>
      </div>

      <input
        class="q-interval__input"
        :value="modelValue.lower"
        inputmode="text"
        placeholder="−∞"
        aria-label="Untere Grenze (leer = unbeschränkt)"
        :readonly="review"
        @input="patch({ lower: ($event.target as HTMLInputElement).value })"
      />
      <span class="q-interval__sep">;</span>
      <input
        class="q-interval__input"
        :value="modelValue.upper"
        inputmode="text"
        placeholder="∞"
        aria-label="Obere Grenze (leer = unbeschränkt)"
        :readonly="review"
        @input="patch({ upper: ($event.target as HTMLInputElement).value })"
      />

      <div class="q-interval__toggle-col">
        <div class="q-interval__toggle" role="group" aria-label="Obere Grenze offen oder geschlossen">
          <button
            type="button"
            class="q-interval__bracket"
            :class="{ 'q-interval__bracket--on': !modelValue.upperClosed }"
            :disabled="review"
            @click="patch({ upperClosed: false })"
          >
            )
          </button>
          <button
            type="button"
            class="q-interval__bracket"
            :class="{ 'q-interval__bracket--on': modelValue.upperClosed }"
            :disabled="review"
            @click="patch({ upperClosed: true })"
          >
            ]
          </button>
        </div>
        <span class="q-interval__toggle-label">{{ modelValue.upperClosed ? 'geschl.' : 'offen' }}</span>
      </div>
    </div>

    <div v-if="!review" class="q-interval__preview">
      Ergebnis: <b class="q-interval__preview-val">{{ preview }}</b>
      <span class="q-interval__hint">leer oder ∞ = unbeschränkt · Komma oder Punkt</span>
    </div>

    <div v-else class="q-interval__review">
      <div
        class="q-interval__verdict"
        :class="result!.verdict === 'correct' ? 'q-interval__verdict--ok' : 'q-interval__verdict--err'"
      >
        <StateIcon :state="result!.verdict === 'correct' ? 'correct' : 'incorrect'" :size="20" />
        <span>Deine Antwort: <b>{{ preview }}</b></span>
      </div>
      <div v-if="result!.verdict !== 'correct'" class="q-interval__correct">
        <StateIcon state="missed" :size="20" />
        <span>Richtig: <b>{{ correctNotation }}</b></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-interval__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  justify-content: center;
  padding: 8px 0;
  flex-wrap: wrap;
}
.q-interval__toggle-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.q-interval__toggle {
  display: flex;
  height: 42px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  overflow: hidden;
  box-sizing: border-box;
}
.q-interval__bracket {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 35px;
  padding: 0;
  font-size: 15px;
  border: none;
  background: var(--q-card);
  color: var(--q-disabled);
  cursor: pointer;
  font-family: inherit;
}
.q-interval__bracket--on {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 700;
}
.q-interval__bracket:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}
.q-interval__toggle-label {
  font-size: 10px;
  color: var(--q-faint);
}
.q-interval__input {
  width: 76px;
  height: 42px;
  box-sizing: border-box;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  padding: 10px;
  text-align: center;
  font-size: 15px;
  background: var(--q-card);
  color: var(--q-ink);
}
.q-interval__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 9px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-interval__sep {
  display: inline-flex;
  align-items: center;
  height: 42px;
  font-size: 16px;
  color: var(--q-mut-2);
}
.q-interval__preview {
  margin-top: 12px;
  text-align: center;
  font-size: 13px;
  color: var(--q-mut-2);
}
.q-interval__preview-val {
  color: var(--q-ink);
  font-size: 15px;
}
.q-interval__hint {
  display: block;
  margin-top: 6px;
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}
.q-interval__review {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-interval__verdict,
.q-interval__correct {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  border-radius: 10px;
  font-size: 13.5px;
}
.q-interval__verdict--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
}
.q-interval__verdict--err {
  border: 1.5px solid var(--q-err);
  background: var(--q-err-bg);
}
.q-interval__correct {
  border: 1.5px dashed var(--q-ok);
}
</style>
