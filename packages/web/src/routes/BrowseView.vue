<script setup lang="ts">
/** Aufgaben browse + filter (prototype 4a). */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  competencyCategory,
  type QuestionsFilter,
  type QuestionSummary,
  type Term,
  type ExamPart,
} from '@qed2/core-logic';
import { QButton, QChip } from '@qed2/ui';
import { useAppStore } from '../stores/app.js';
import { useProgressStore } from '../stores/progress.js';

const router = useRouter();
const app = useAppStore();
const progress = useProgressStore();

const YEARS = Array.from({ length: 13 }, (_, i) => 2014 + i);
const TERMS: { value: Term; label: string }[] = [
  { value: 'haupttermin', label: 'Haupttermin' },
  { value: 'nebentermin-1', label: 'Nebentermin 1' },
  { value: 'nebentermin-2', label: 'Nebentermin 2' },
  { value: 'herbsttermin', label: 'Herbsttermin' },
  { value: 'wintertermin', label: 'Wintertermin' },
];
const CATEGORIES = ['AG', 'FA', 'AN', 'WS'] as const;

const year = ref<string>('');
const term = ref<string>('');
const teil = ref<string>('');
const category = ref<string>('');

const items = ref<QuestionSummary[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref<string | undefined>();

const anyFilter = computed(() => year.value !== '' || term.value !== '' || teil.value !== '' || category.value !== '');

function buildFilter(p: number): QuestionsFilter {
  const f: QuestionsFilter = { page: p, pageSize: 100 };
  if (year.value) f.year = Number(year.value);
  if (term.value) f.term = term.value as Term;
  if (teil.value) f.part = teil.value as ExamPart;
  return f;
}

async function load(append = false): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    const res = await app.coreClient.listQuestions(buildFilter(append ? page.value + 1 : 1));
    if (append) {
      items.value = [...items.value, ...res.items];
      page.value += 1;
    } else {
      items.value = res.items;
      page.value = 1;
    }
    total.value = res.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
watch([year, term, teil], () => void load());

/** Category filtering is client-side (the API's gk param wants full codes). */
const filtered = computed(() => {
  if (!category.value) return items.value;
  return items.value.filter((q) =>
    q.parts.some((p) => p.competencies.some((c) => competencyCategory(c.code) === category.value)),
  );
});

function resetFilters(): void {
  year.value = '';
  term.value = '';
  teil.value = '';
  category.value = '';
}

interface RowState {
  disc: 'done' | 'partial' | 'due' | 'new';
  label: string;
}

function rowState(q: QuestionSummary): RowState {
  const states = q.parts.map((p) => progress.partState.get(p.id));
  const graded = states.filter((s) => s !== undefined);
  const anyDue = states.some((s) => s?.due);
  if (graded.length === 0) return { disc: 'new', label: 'Neu' };
  if (anyDue) return { disc: 'due', label: 'Fällig' };
  const allCorrect = graded.length === q.parts.length && graded.every((s) => s!.correct);
  if (allCorrect) return { disc: 'done', label: `Bearbeitet · ${graded.length}/${q.parts.length}` };
  return { disc: 'partial', label: `Teilweise · ${graded.filter((s) => s!.correct).length}/${q.parts.length}` };
}

const playableIds = computed(() => filtered.value.filter((q) => q.playable).map((q) => q.id));

function practiceAll(): void {
  if (playableIds.value.length === 0) return;
  void router.push({ path: '/ueben', query: { questions: playableIds.value.join(',') } });
}

function practiceOne(q: QuestionSummary): void {
  if (!q.playable) return;
  void router.push({ path: '/ueben', query: { questions: q.id } });
}

function firstCode(q: QuestionSummary): string | undefined {
  return q.parts[0]?.competencies[0]?.code;
}
</script>

<template>
  <div class="browse">
    <div class="browse__head">
      <h1 class="browse__title">Aufgaben</h1>
      <QButton :disabled="playableIds.length === 0" @click="practiceAll">Ganze Auswahl üben →</QButton>
    </div>

    <div class="browse__filters">
      <select v-model="year" class="browse__select" aria-label="Jahr">
        <option value="">Jahr: Alle</option>
        <option v-for="y in YEARS" :key="y" :value="String(y)">Jahr: {{ y }}</option>
      </select>
      <select v-model="term" class="browse__select" aria-label="Termin">
        <option value="">Termin: Alle</option>
        <option v-for="t in TERMS" :key="t.value" :value="t.value">Termin: {{ t.label }}</option>
      </select>
      <select v-model="teil" class="browse__select" aria-label="Teil">
        <option value="">Teil: Alle</option>
        <option value="t1">Teil 1</option>
        <option value="t2">Teil 2</option>
      </select>
      <select v-model="category" class="browse__select" aria-label="Kompetenz">
        <option value="">Kompetenz: Alle</option>
        <option v-for="c in CATEGORIES" :key="c" :value="c">Kompetenz: {{ c }}</option>
      </select>
      <button v-if="anyFilter" type="button" class="browse__reset" @click="resetFilters">✕ Zurücksetzen</button>
    </div>

    <div class="browse__meta">
      <span v-if="!loading">{{ category ? filtered.length : total }} Aufgaben</span>
      <span v-else>Lade …</span>
    </div>

    <div v-if="error" class="browse__error">
      Aufgabenliste konnte nicht geladen werden: {{ error }}
      <QButton variant="secondary" @click="load()">Erneut versuchen</QButton>
    </div>

    <div v-else-if="loading && items.length === 0" class="browse__list">
      <div v-for="i in 6" :key="i" class="browse__skeleton" />
    </div>

    <div v-else-if="filtered.length === 0" class="browse__empty">Keine Aufgaben für diese Filter.</div>

    <div v-else class="browse__list">
      <button
        v-for="q in filtered"
        :key="q.id"
        type="button"
        class="browse__row"
        :class="{ 'browse__row--disabled': !q.playable }"
        :disabled="!q.playable"
        @click="practiceOne(q)"
      >
        <span class="browse__disc" :class="`browse__disc--${rowState(q).disc}`" aria-hidden="true" />
        <span class="browse__nr">{{ q.source.nr }}</span>
        <QChip v-if="firstCode(q)">{{ firstCode(q) }}</QChip>
        <span class="browse__qtitle">{{ q.title }}</span>
        <span v-if="!q.playable" class="browse__state browse__state--na">Noch nicht verfügbar</span>
        <span v-else class="browse__state" :class="`browse__state--${rowState(q).disc}`">{{ rowState(q).label }}</span>
      </button>
      <div v-if="!category && items.length < total" class="browse__more">
        <QButton variant="secondary" :disabled="loading" @click="load(true)">
          {{ loading ? 'Lade …' : 'Mehr laden' }}
        </QButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browse {
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.browse__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.browse__title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0;
}
.browse__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.browse__select {
  padding: 7px 10px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-ink);
  cursor: pointer;
}
.browse__select:focus-visible {
  outline: 2px solid var(--q-accent);
}
.browse__reset {
  border: none;
  background: none;
  font-size: 12px;
  color: var(--q-mut-2);
  cursor: pointer;
  padding: 7px 10px;
  font-family: inherit;
}
.browse__meta {
  font-size: 12px;
  color: var(--q-mut-2);
  padding: 4px 2px 10px;
}
.browse__list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.browse__row {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px 14px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  color: var(--q-ink);
  text-align: left;
  width: 100%;
}
.browse__row:hover:not(:disabled) {
  border-color: var(--q-accent);
}
.browse__row:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.browse__row--disabled {
  opacity: 0.55;
  cursor: default;
}
.browse__disc {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  flex: none;
  box-sizing: border-box;
}
.browse__disc--done {
  background: var(--q-ok);
}
.browse__disc--partial {
  border: 1.5px solid var(--q-part);
  background: linear-gradient(90deg, var(--q-part) 50%, transparent 50%);
}
.browse__disc--due {
  background: var(--q-accent);
}
.browse__disc--new {
  border: 1.5px solid var(--q-btn-border);
}
.browse__nr {
  font-weight: 700;
  font-size: 13.5px;
  width: 30px;
  flex: none;
}
.browse__qtitle {
  font-size: 12.5px;
  color: var(--q-mut);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browse__state {
  font-size: 11px;
  font-weight: 700;
  flex: none;
}
.browse__state--done {
  color: var(--q-ok);
}
.browse__state--partial {
  color: var(--q-part);
}
.browse__state--due {
  color: var(--q-accent-strong);
}
.browse__state--new {
  color: var(--q-faint);
  font-weight: 600;
}
.browse__state--na {
  color: var(--q-faint);
  font-weight: 500;
}
.browse__skeleton {
  height: 44px;
  border-radius: 10px;
  background: var(--q-panel);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}
.browse__empty,
.browse__error {
  padding: 24px;
  text-align: center;
  color: var(--q-mut-2);
  font-size: 13px;
  background: var(--q-panel);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.browse__more {
  display: flex;
  justify-content: center;
  padding: 12px 0;
}
@media (max-width: 640px) {
  .browse__qtitle {
    display: none;
  }
}
</style>
