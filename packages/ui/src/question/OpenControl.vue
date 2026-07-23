<script setup lang="ts">
/**
 * Open control — prose and formulas share one free-text answer. Formula-only
 * input gets an automatic live preview; mixed prose can mark formulas with
 * $...$. The stored submission remains plain text, so sync/grading contracts
 * do not change. Empty is allowed ("answered on paper").
 */
import { computed, ref } from 'vue';
import {
  expressionPreviewLatex,
  type GradeResult,
  type OpenAnswer,
  type OpenSubmission,
  type RichText,
} from '@qed2/core-logic';
import RichTextView from '../shared/RichTextView.vue';

const props = defineProps<{
  answer: OpenAnswer;
  modelValue: OpenSubmission;
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: OpenSubmission] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const review = computed(() => props.result != null);

type FormulaTool = {
  label: string;
  title: string;
  insert: string;
  action?: 'insert' | 'wrap-formula';
  cursorBack?: number;
};

const TOOLBAR: FormulaTool[] = [
  { label: 'ƒx', title: 'Formel markieren ($…$)', insert: '$$', action: 'wrap-formula', cursorBack: 1 },
  { label: 'xⁿ', title: 'Potenz', insert: '^' },
  { label: '√', title: 'Wurzel', insert: 'sqrt()', cursorBack: 1 },
  { label: 'a⁄b', title: 'Bruch', insert: '/' },
  { label: 'π', title: 'Pi', insert: 'pi' },
  { label: '·', title: 'Multiplikation', insert: '*' },
  { label: '( )', title: 'Klammern', insert: '()', cursorBack: 1 },
];

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

function onInput(ev: Event): void {
  const el = ev.target as HTMLTextAreaElement;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
  emit('update:modelValue', { ...props.modelValue, text: el.value });
}

function insert(tool: FormulaTool): void {
  if (review.value) return;
  const el = textarea.value;
  const value = props.modelValue.text;
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const wrapsSelection = tool.action === 'wrap-formula' && selected.length > 0;
  const inserted = wrapsSelection ? `$${selected}$` : tool.insert;
  const next = value.slice(0, start) + inserted + value.slice(end);
  emit('update:modelValue', { ...props.modelValue, text: next });
  requestAnimationFrame(() => {
    if (!el) return;
    const pos =
      wrapsSelection
        ? start + inserted.length
        : start + inserted.length - (tool.cursorBack ?? 0);
    el.focus();
    el.setSelectionRange(pos, pos);
  });
}

function onToolMousedown(tool: FormulaTool): void {
  insert(tool);
}
function onToolClick(tool: FormulaTool, ev: MouseEvent): void {
  // Pointer activation already inserted on mousedown so the textarea keeps
  // its selection. Keyboard activation has no mousedown and reports detail 0.
  if (ev.detail === 0) insert(tool);
}
</script>

<template>
  <div class="q-open">
    <div v-if="!review" class="q-open__toolbar" role="toolbar" aria-label="Mathematische Symbole einfügen">
      <button
        v-for="tool in TOOLBAR"
        :key="tool.label"
        type="button"
        class="q-open__tool"
        :title="tool.title"
        :aria-label="tool.title"
        @mousedown.prevent="onToolMousedown(tool)"
        @click="onToolClick(tool, $event)"
      >
        {{ tool.label }}
      </button>
    </div>

    <textarea
      ref="textarea"
      class="q-open__area"
      :value="modelValue.text"
      :readonly="review"
      rows="4"
      placeholder="Deine Antwort (optional — du kannst auch auf Papier arbeiten)"
      aria-label="Offene Antwort"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      @input="onInput"
    />

    <div v-if="previewNodes" class="q-open__preview" aria-live="polite">
      <span class="q-open__preview-label">Vorschau</span>
      <RichTextView :nodes="previewNodes" />
    </div>

    <div v-if="!review" class="q-open__hint">
      Text oder Formel · in Fließtext Formeln mit $…$ markieren · ^ Potenz · / Bruch · sqrt() Wurzel
    </div>
  </div>
</template>

<style scoped>
.q-open__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}

.q-open__tool {
  min-width: 36px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0 9px;
  border: 1px solid var(--q-border-2);
  border-radius: 7px;
  background: var(--q-card);
  color: var(--q-ink);
  cursor: pointer;
  font: italic 14px Georgia, serif;
}

@media (hover: hover) and (pointer: fine) {
  .q-open__tool:hover {
    background: var(--q-panel);
  }
}

.q-open__tool:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}

.q-open__area {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  border: 1px solid var(--q-border-3);
  border-radius: 10px;
  padding: 12px 13px;
  background: var(--q-card);
  color: var(--q-ink);
  font-size: 16px; /* ≥16px: no iOS focus-zoom */
  line-height: 1.6;
  font-family: inherit;
}
.q-open__area:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 11px 12px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
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

.q-open__preview-label {
  flex: none;
  color: var(--q-faint);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.q-open__hint {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--q-faint);
}

@media (pointer: coarse) {
  .q-open__tool {
    min-width: 44px;
    height: 44px;
  }
}
</style>
