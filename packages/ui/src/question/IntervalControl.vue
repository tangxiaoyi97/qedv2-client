<script setup lang="ts">
import { computed } from 'vue';
import type { GradeResult, IntervalAnswer, IntervalSubmission } from '@qed2/core-logic';
import StateIcon from '../shared/StateIcon.vue';
import { useI18n } from '../i18n.js';
import { formatIntervalSubmissionPreview } from './submission-preview.js';
import { onMathInputKeydown } from './math-input.js';

const { t, formatNumber } = useI18n();

const props = defineProps<{
  answer: IntervalAnswer;
  modelValue: IntervalSubmission;
  result?: GradeResult | null;
  showPreview?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: IntervalSubmission] }>();
const review = computed(() => props.result != null);

function patch(value: Partial<IntervalSubmission>): void {
  if (!review.value) emit('update:modelValue', { ...props.modelValue, ...value });
}
function onInput(bound: 'lower' | 'upper', event: Event): void {
  if ((event as InputEvent).isComposing) return;
  patch({ [bound]: (event.target as HTMLInputElement).value });
}
const preview = computed(() => formatIntervalSubmissionPreview(props.modelValue));
const correctNotation = computed(() => {
  const answer = props.answer;
  const lower = answer.lower === null ? '−∞' : formatNumber(answer.lower, { maximumFractionDigits: 6 });
  const upper = answer.upper === null ? '∞' : formatNumber(answer.upper, { maximumFractionDigits: 6 });
  return `${answer.lower !== null && answer.lowerClosed ? '[' : '('} ${lower} ; ${upper} ${answer.upper !== null && answer.upperClosed ? ']' : ')'}`;
});
</script>

<template>
  <div class="q-interval" data-answer-fields>
    <div class="q-interval__row" :class="{ 'q-interval__row--review': review }">
      <select
        class="q-interval__bracket q-select"
        :value="String(modelValue.lowerClosed)"
        :disabled="review"
        :aria-label="t('Untere Grenze offen oder geschlossen')"
        @change="patch({ lowerClosed: ($event.target as HTMLSelectElement).value === 'true' })"
      >
        <option value="false">(</option>
        <option value="true">[</option>
      </select>
      <input
        class="q-interval__input q-input"
        :value="modelValue.lower"
        type="text"
        inputmode="text"
        enterkeyhint="next"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="−∞"
        :aria-label="t('Untere Grenze (leer = unbeschränkt)')"
        :readonly="review"
        @input="onInput('lower', $event)"
        @compositionend="onInput('lower', $event)"
        @keydown="onMathInputKeydown"
      />
      <span class="q-interval__sep" aria-hidden="true">;</span>
      <input
        class="q-interval__input q-input"
        :value="modelValue.upper"
        type="text"
        inputmode="text"
        enterkeyhint="done"
        autocomplete="off"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        placeholder="∞"
        :aria-label="t('Obere Grenze (leer = unbeschränkt)')"
        :readonly="review"
        @input="onInput('upper', $event)"
        @compositionend="onInput('upper', $event)"
        @keydown="onMathInputKeydown"
      />
      <select
        class="q-interval__bracket q-select"
        :value="String(modelValue.upperClosed)"
        :disabled="review"
        :aria-label="t('Obere Grenze offen oder geschlossen')"
        @change="patch({ upperClosed: ($event.target as HTMLSelectElement).value === 'true' })"
      >
        <option value="true">]</option>
        <option value="false">)</option>
      </select>
    </div>
    <div v-if="!review && showPreview !== false" class="q-interval__preview" :aria-label="t('Vorschau')">{{ preview }}</div>
    <div v-else-if="review" class="q-interval__review">
      <div class="q-interval__verdict q-reveal" :class="{
        'q-interval__verdict--ok': result!.verdict === 'correct',
        'q-interval__verdict--partial': result!.verdict === 'partial',
        'q-interval__verdict--err': result!.verdict === 'incorrect',
      }">
        <StateIcon :state="result!.verdict" :size="20" />
        <span>{{ t('Deine Antwort') }}: <b>{{ preview }}</b></span>
      </div>
      <div v-if="result!.verdict !== 'correct'" class="q-interval__correct">
        <StateIcon state="missed" :size="20" />
        <span>{{ t('Richtig') }}: <b>{{ correctNotation }}</b></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-interval__row { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto minmax(0, 1fr) 48px; align-items: center; gap: 6px; }
.q-interval__input { width: 100%; text-align: center; }
.q-interval__bracket { width: 48px; padding-inline: 9px 19px; background-position: right 4px center; cursor: pointer; }
.q-interval__sep { color: var(--q-mut); }
.q-interval__preview { margin-top: 8px; text-align: center; font-size: 15px; font-variant-numeric: tabular-nums; color: var(--q-mut); }
.q-interval__review { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.q-interval__verdict, .q-interval__correct { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: var(--q-radius-control, 10px); font-size: 14px; }
.q-interval__verdict--ok { border: 1px solid var(--q-ok); background: var(--q-ok-bg); }
.q-interval__verdict--partial { border: 1px solid var(--q-part-border); background: var(--q-part-bg); }
.q-interval__verdict--err { border: 1px solid var(--q-err); background: var(--q-err-bg); }
.q-interval__correct { border: 1px dashed var(--q-ok); }
</style>
