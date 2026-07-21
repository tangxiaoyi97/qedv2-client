<script setup lang="ts">
/**
 * open control — free-text answer area (prototype 2e, upper half). Empty is
 * allowed ("answered on paper"); the self-assessment against the rubric
 * happens after submitting (SelfAssessmentPanel, driven by PartPlayer).
 */
import { computed } from 'vue';
import type { GradeResult, OpenAnswer } from '@qed2/core-logic';
import type { OpenSubmission } from '@qed2/core-logic';

const props = defineProps<{
  answer: OpenAnswer;
  modelValue: OpenSubmission;
  result?: GradeResult | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: OpenSubmission] }>();

const review = computed(() => props.result != null);

function onInput(ev: Event): void {
  const el = ev.target as HTMLTextAreaElement;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
  emit('update:modelValue', { ...props.modelValue, text: el.value });
}
</script>

<template>
  <div class="q-open">
    <textarea
      class="q-open__area"
      :value="modelValue.text"
      :readonly="review"
      rows="4"
      placeholder="Deine Antwort (optional — du kannst auch auf Papier arbeiten)"
      aria-label="Offene Antwort"
      @input="onInput"
    />
    <div v-if="!review" class="q-open__hint">
      Begründung, Rechenweg oder Skizzenbeschreibung — anschließend vergleichst du mit der Lösung.
    </div>
  </div>
</template>

<style scoped>
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
.q-open__hint {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--q-faint);
}
</style>
