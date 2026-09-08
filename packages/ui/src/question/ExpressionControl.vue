<script setup lang="ts">
import { computed } from 'vue';
import { expressionPreviewLatex } from '@qed2/core-logic';
import type { ExpressionAnswer, GradeResult } from '@qed2/core-logic';
import MathText from '../shared/MathText.vue';
import StateIcon from '../shared/StateIcon.vue';
import { useI18n } from '../i18n.js';
import { onMathInputKeydown } from './math-input.js';

const { t } = useI18n();

const props = defineProps<{
  answer: ExpressionAnswer;
  modelValue: string;
  result?: GradeResult | null;
  indeterminate?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const review = computed(() => props.result != null || props.indeterminate === true);
const previewLatex = computed(() => expressionPreviewLatex(props.modelValue));

function onInput(event: Event): void {
  if (review.value || (event as InputEvent).isComposing) return;
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="q-expr" data-answer-fields>
    <input
      class="q-expr__input q-input"
      :class="{
        'q-expr__input--ok': result?.verdict === 'correct',
        'q-expr__input--err': result != null && result.verdict !== 'correct',
        'q-expr__input--indet': indeterminate,
      }"
      type="text"
      inputmode="text"
      :value="modelValue"
      :readonly="review"
      spellcheck="false"
      autocapitalize="off"
      autocorrect="off"
      autocomplete="off"
      enterkeyhint="done"
      :placeholder="t('z. B. 2*x + 3')"
      :aria-label="t('Mathematischer Ausdruck')"
      @input="onInput"
      @compositionend="onInput"
      @keydown="onMathInputKeydown"
    />

    <div v-if="!review && previewLatex" class="q-expr__preview" :aria-label="t('Vorschau')">
      <MathText :src="previewLatex" />
    </div>

    <template v-if="review">
      <div v-if="result" class="q-expr__verdict-note">
        <StateIcon :state="result.verdict === 'correct' ? 'correct' : 'incorrect'" :size="20" />
        <span>{{ t(result.verdict === 'correct' ? 'Richtig' : 'Falsch') }}</span>
      </div>
      <div class="q-expr__canonical">
        <span class="q-expr__preview-label">{{ t('Richtige Antwort') }}</span>
        <MathText :src="answer.canonical" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.q-expr__input { width: 100%; font-family: ui-monospace, Menlo, monospace; }
.q-expr__input--ok { border-color: var(--q-ok); background: var(--q-ok-bg); }
.q-expr__input--err { border-color: var(--q-err); background: var(--q-err-bg); }
.q-expr__input--indet { border-color: var(--q-part-border); background: var(--q-part-bg); }
.q-expr__preview,
.q-expr__canonical {
  margin-top: 8px;
  padding: 10px 12px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control, 10px);
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
}
.q-expr__preview-label { font-size: 12px; font-weight: 600; color: var(--q-mut); flex: none; }
.q-expr__verdict-note { margin-top: 12px; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.q-expr__canonical { border-color: var(--q-ok); border-style: dashed; background: var(--q-card); flex-wrap: wrap; }
</style>
