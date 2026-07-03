<script setup lang="ts">
/**
 * Question meta header (prototype 1b sub-bar): competency chips, exam-source
 * line ("Haupttermin 2021 · Teil 1") and right-aligned points.
 */
import { computed } from 'vue';
import type { Question, Competency, Term } from '@qed2/core-logic';
import QChip from '../shared/QChip.vue';

const props = defineProps<{
  question: Pick<Question, 'title' | 'source'>;
  competencies: Competency[];
  points?: number;
}>();

const TERM_LABELS: Record<Term, string> = {
  haupttermin: 'Haupttermin',
  'nebentermin-1': 'Nebentermin 1',
  'nebentermin-2': 'Nebentermin 2',
  herbsttermin: 'Herbsttermin',
  wintertermin: 'Wintertermin',
};

const uniqueCodes = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of props.competencies) {
    if (!seen.has(c.code)) {
      seen.add(c.code);
      out.push(c.code);
    }
  }
  return out;
});

const sourceLine = computed(() => {
  const { term, year, part } = props.question.source;
  const termLabel = TERM_LABELS[term] ?? term;
  const partLabel = part === 't1' ? 'Teil 1' : 'Teil 2';
  return `${termLabel} ${year} · ${partLabel}`;
});

const pointsLine = computed(() => {
  if (props.points == null) return null;
  const n = String(props.points).replace('.', ',');
  return `${n} ${props.points === 1 ? 'Punkt' : 'Punkte'}`;
});
</script>

<template>
  <div class="q-qheader">
    <div class="q-qheader__title">{{ question.title }}</div>
    <div class="q-qheader__meta">
      <QChip v-for="code in uniqueCodes" :key="code">{{ code }}</QChip>
      <span class="q-qheader__source">{{ sourceLine }}</span>
      <span v-if="pointsLine" class="q-qheader__points">{{ pointsLine }}</span>
    </div>
  </div>
</template>

<style scoped>
.q-qheader {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.q-qheader__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
  color: var(--q-ink);
  overflow-wrap: break-word;
}
.q-qheader__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.q-qheader__source {
  font-size: 12px;
  color: var(--q-mut-2);
}
.q-qheader__points {
  margin-left: auto;
  font-size: 12px;
  color: var(--q-faint);
  white-space: nowrap;
}
</style>
