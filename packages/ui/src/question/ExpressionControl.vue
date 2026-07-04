<script setup lang="ts">
/**
 * expression control — text input + symbol toolbar + live KaTeX preview
 * (prototype 2d). Grading is CAS-based; when it reports indeterminate the
 * parent shows the self-assessment panel and this control renders the
 * canonical answer for comparison.
 */
import { computed, ref } from 'vue';
import { expressionPreviewLatex } from '@qed2/core-logic';
import type { ExpressionAnswer, GradeResult } from '@qed2/core-logic';
import MathText from '../shared/MathText.vue';
import StateIcon from '../shared/StateIcon.vue';

const props = defineProps<{
  answer: ExpressionAnswer;
  modelValue: string;
  result?: GradeResult | null;
  indeterminate?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const input = ref<HTMLInputElement | null>(null);
const review = computed(() => props.result != null || props.indeterminate === true);

const previewLatex = computed(() => expressionPreviewLatex(props.modelValue));

const TOOLBAR: { label: string; insert: string; cursorBack?: number }[] = [
  { label: 'xⁿ', insert: '^' },
  { label: '√', insert: 'sqrt()', cursorBack: 1 },
  { label: 'a⁄b', insert: '/' },
  { label: 'π', insert: 'pi' },
  { label: '·', insert: '*' },
  { label: '( )', insert: '()', cursorBack: 1 },
];

function insert(tool: (typeof TOOLBAR)[number]): void {
  if (review.value) return;
  const el = input.value;
  const value = props.modelValue;
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + tool.insert + value.slice(end);
  emit('update:modelValue', next);
  requestAnimationFrame(() => {
    if (!el) return;
    const pos = start + tool.insert.length - (tool.cursorBack ?? 0);
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}
</script>

<template>
  <div class="q-expr">
    <div v-if="!review" class="q-expr__toolbar" role="toolbar" aria-label="Symbole einfügen">
      <button
        v-for="tool in TOOLBAR"
        :key="tool.label"
        type="button"
        class="q-expr__tool"
        :title="tool.insert"
        @mousedown.prevent="insert(tool)"
      >
        {{ tool.label }}
      </button>
    </div>

    <input
      ref="input"
      class="q-expr__input"
      :class="{
        'q-expr__input--ok': result?.verdict === 'correct',
        'q-expr__input--err': result != null && result.verdict !== 'correct',
        'q-expr__input--indet': indeterminate,
      }"
      :value="modelValue"
      :readonly="review"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      placeholder="z. B. 2*x + 3"
      aria-label="Mathematischer Ausdruck"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />

    <div v-if="!review && previewLatex" class="q-expr__preview">
      <span class="q-expr__preview-label">Vorschau</span>
      <MathText :src="previewLatex" />
    </div>
    <div v-if="!review" class="q-expr__hint">^ Potenz · * Mal · / Bruch · sqrt() Wurzel · Komma oder Punkt</div>

    <template v-if="review">
      <div v-if="result" class="q-expr__verdict-note">
        <StateIcon :state="result.verdict === 'correct' ? 'correct' : 'incorrect'" :size="20" />
        <span>{{ result.verdict === 'correct' ? 'Richtig' : 'Falsch' }}</span>
      </div>
      <div class="q-expr__canonical">
        <span class="q-expr__preview-label">Richtige Antwort</span>
        <MathText :src="answer.canonical" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.q-expr__toolbar {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.q-expr__tool {
  width: 36px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--q-border-2);
  border-radius: 7px;
  background: var(--q-card);
  color: var(--q-ink);
  font-size: 14px;
  font-family: Georgia, serif;
  font-style: italic;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .q-expr__tool:hover {
    background: var(--q-panel);
  }
}
.q-expr__tool:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.q-expr__input {
  width: 100%;
  border: 1px solid var(--q-border-3);
  border-radius: 9px;
  padding: 12px 14px;
  font-size: 16px;
  font-family: ui-monospace, Menlo, monospace;
  background: var(--q-card);
  color: var(--q-ink);
}
.q-expr__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 11px 13px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.q-expr__input--ok {
  border: 1.5px solid var(--q-ok);
  background: var(--q-ok-bg);
}
.q-expr__input--err {
  border: 1.5px solid var(--q-err);
  background: var(--q-err-bg);
}
.q-expr__input--indet {
  border: 1.5px solid var(--q-part-border);
  background: var(--q-part-bg);
}
.q-expr__preview {
  margin-top: 12px;
  padding: 11px 14px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
}
.q-expr__preview-label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  flex: none;
}
.q-expr__hint {
  margin-top: 10px;
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}
.q-expr__verdict-note {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
}
.q-expr__canonical {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1.5px dashed var(--q-ok);
  border-radius: 9px;
  display: flex;
  align-items: center;
  gap: 12px;
  overflow-x: auto;
}
</style>
