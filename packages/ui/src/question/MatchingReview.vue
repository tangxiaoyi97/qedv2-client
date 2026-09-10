<script setup lang="ts">
import { computed } from 'vue';
import type { GradeResult, MatchingAnswer } from '@qed2/core-logic';
import { useI18n } from '../i18n.js';
import RichTextView from '../shared/RichTextView.vue';
import StateIcon from '../shared/StateIcon.vue';

const props = defineProps<{
  answer: MatchingAnswer;
  modelValue: (number | null)[];
  result: GradeResult;
}>();
const { t } = useI18n();
const rows = computed(() => {
  const marks = new Map(props.result.breakdown?.map(mark => [mark.ref, mark]));
  const expected = new Map(props.answer.pairs);
  const validIndex = (value: number | null | undefined): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < props.answer.right.length ? value : null;
  return props.answer.left.map((item, index) => ({
    item,
    chosen: validIndex(props.modelValue[index]),
    expected: validIndex(expected.get(index)),
    correct: marks.get(String(index))?.correct,
  }));
});
const letter = (index: number) => String.fromCharCode(65 + index);
</script>

<template>
  <div class="q-match-review">
    <table role="table" class="q-match-review__table" :aria-label="t('Zuordnungen vergleichen')">
      <thead role="rowgroup">
        <tr role="row">
          <th role="columnheader" scope="col">{{ t('Zuordnung') }}</th>
          <th role="columnheader" scope="col">{{ t('Gewählt') }}</th>
          <th role="columnheader" scope="col">{{ t('Lösung') }}</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        <tr v-for="(row, index) in rows" :key="index" role="row" class="q-match-review__row">
          <th role="rowheader" scope="row" class="q-match-review__prompt">
            <RichTextView :nodes="row.item" inline-only />
          </th>
          <td role="cell" class="q-match-review__chosen" :class="{ 'q-match-review__chosen--wrong': row.correct === false }">
            <span class="q-match-review__label" aria-hidden="true">{{ t('Gewählt') }}</span>
            <div class="q-match-review__answer">
              <span v-if="row.chosen !== null" class="q-match-review__letter">{{ letter(row.chosen) }}</span>
              <RichTextView v-if="row.chosen !== null" :nodes="answer.right[row.chosen]" inline-only />
              <span v-else class="q-match-review__muted">{{ t('Keine Auswahl') }}</span>
              <StateIcon v-if="row.correct === false" state="incorrect" :label="t('Falsch')" :size="16" class="q-match-review__mark" />
            </div>
          </td>
          <td role="cell" class="q-match-review__solution">
            <span class="q-match-review__label" aria-hidden="true">{{ t('Lösung') }}</span>
            <div v-if="row.correct === true" class="q-match-review__confirmed">
              <StateIcon state="correct" :size="16" aria-hidden="true" />
              {{ t('Richtig') }}
            </div>
            <div v-else-if="row.correct === false" class="q-match-review__answer">
              <span v-if="row.expected !== null" class="q-match-review__letter q-match-review__letter--solution">{{ letter(row.expected) }}</span>
              <RichTextView v-if="row.expected !== null" :nodes="answer.right[row.expected]" inline-only />
              <span v-else class="q-match-review__muted">{{ t('Keine Zuordnung') }}</span>
            </div>
            <span v-else class="q-match-review__muted">{{ t('Nicht bewertet') }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.q-match-review { container: matching-review / inline-size; min-width: 0; }
.q-match-review__table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  text-align: left;
  font-size: 14px;
  line-height: 1.6;
}
.q-match-review__table thead th {
  padding: 0 16px 10px;
  border-bottom: 1px solid var(--q-border-2);
  color: var(--q-faint);
  font-size: 11px;
  font-weight: 600;
}
.q-match-review__table thead th:first-child { width: 36%; padding-left: 0; }
.q-match-review__table thead th:last-child { padding-right: 0; }
.q-match-review__row > * {
  padding: 18px 16px;
  border-bottom: 1px solid var(--q-border-soft);
  vertical-align: top;
  overflow-wrap: anywhere;
  min-width: 0;
}
.q-match-review__prompt { padding-left: 0; font-weight: 500; }
.q-match-review__solution { padding-right: 0; }
.q-match-review__answer {
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}
.q-match-review__answer > :deep(.q-richtext) { min-width: 0; flex: 1; }
.q-match-review__letter {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--q-panel-2);
  color: var(--q-mut);
  font: 700 11px ui-monospace, Menlo, monospace;
}
.q-match-review__chosen--wrong { color: var(--q-mut); }
.q-match-review__chosen--wrong .q-match-review__letter { color: var(--q-err-ink); background: var(--q-err-bg); }
.q-match-review__letter--solution { color: var(--q-ok); background: var(--q-ok-bg); }
.q-match-review__mark { align-self: flex-start; flex: none; margin-top: 4px; }
.q-match-review__confirmed { display: flex; align-items: center; gap: 8px; min-height: 24px; color: var(--q-ok); font-size: 12px; }
.q-match-review__muted { color: var(--q-faint); font-size: 12px; }
.q-match-review__label { display: none; }
@container matching-review (max-width: 580px) {
  .q-match-review__table, .q-match-review__table tbody { display: block; }
  /* Keep the column headers available to screen readers. */
  .q-match-review__table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .q-match-review__row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; padding: 16px 0; border-bottom: 1px solid var(--q-border-soft); }
  .q-match-review__row:first-child { padding-top: 0; }
  .q-match-review__row > * { padding: 0; border: 0; }
  .q-match-review__prompt { grid-column: 1 / -1; }
  .q-match-review__label { display: block; margin-bottom: 6px; color: var(--q-faint); font-size: 10.5px; font-weight: 500; }
}
@container matching-review (max-width: 380px) {
  .q-match-review__row { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .q-match-review__row td { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: baseline; gap: 8px; }
  .q-match-review__label { margin-bottom: 0; }
}
</style>
