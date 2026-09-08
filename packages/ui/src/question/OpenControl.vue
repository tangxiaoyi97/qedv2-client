<script setup lang="ts">
/**
 * Open control — prose and formulas share one free-text answer. Formula-only
 * input gets an automatic live preview; mixed prose can mark formulas with
 * $...$. The stored submission remains plain text, so sync/grading contracts
 * do not change. Empty is allowed ("answered on paper").
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n.js';
import {
  expressionPreviewLatex,
  type GradeResult,
  type OpenAnswer,
  type OpenSubmission,
  type RichText,
} from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';

const { t } = useI18n();

const props = defineProps<{
  answer: OpenAnswer;
  modelValue: OpenSubmission;
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: OpenSubmission] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const review = computed(() => props.result != null);

function formulaLatex(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  return expressionPreviewLatex(trimmed)
    ?? (/\\[A-Za-z]+|[{}_^]/.test(trimmed) ? trimmed : undefined);
}

const previewNodes = computed<RichText | undefined>(() => {
  const text = props.modelValue.text;
  if (!text.trim()) return undefined;

  const nodes: RichText = [];
  const formula = /(\${1,2})([^$\n]+)\1/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = formula.exec(text)) !== null) {
    if (match.index > cursor) nodes.push({ t: 'text', v: text.slice(cursor, match.index) });
    nodes.push({ t: 'math', v: formulaLatex(match[2] ?? '') ?? (match[2] ?? '') });
    cursor = match.index + match[0].length;
  }
  if (nodes.length > 0) {
    if (cursor < text.length) nodes.push({ t: 'text', v: text.slice(cursor) });
    return nodes;
  }

  const latex = formulaLatex(text);
  return latex ? [{ t: 'math', v: latex }] : undefined;
});

function resize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 96), 320)}px`;
}

function onInput(event: Event): void {
  resize();
  if (review.value || (event as InputEvent).isComposing) return;
  emit('update:modelValue', { ...props.modelValue, text: (event.target as HTMLTextAreaElement).value });
}

onMounted(resize);
watch(() => props.modelValue.text, () => { void nextTick(resize); });
</script>

<template>
  <div class="q-open">
    <textarea
      ref="textarea"
      class="q-open__area q-input"
      :value="modelValue.text"
      :readonly="review"
      rows="4"
      :placeholder="t('Antwort (optional)')"
      :aria-label="t('Offene Antwort')"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      @input="onInput"
      @compositionend="onInput"
    />

    <div v-if="previewNodes" class="q-open__preview" :aria-label="t('Vorschau')">
      <RichTextView :nodes="previewNodes" />
    </div>

  </div>
</template>

<style scoped>
.q-open__area {
  width: 100%;
  min-height: 96px;
  max-height: 320px;
  resize: vertical;
  line-height: 1.6;
  overflow-y: auto;
}
.q-open__area[readonly] {
  background: var(--q-panel);
  color: var(--q-mut);
}

.q-open__preview {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding: 11px 14px;
  overflow-x: auto;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
}

</style>
