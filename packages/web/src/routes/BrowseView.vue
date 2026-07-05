<script lang="ts">
import { ref } from 'vue';
import type { QuestionSummary } from '@qed2/core-logic';

/**
 * Module-level cache: ALL question summaries, fetched once per app session
 * (~7 pages à 100). Re-visits of the route skip the refetch; filtering is
 * entirely client-side, which is what enables multi-select filters.
 */
const allQuestions = ref<QuestionSummary[]>([]);
let fetchedOnce = false;
</script>

<script setup lang="ts">
/** Aufgaben browse — client-side multi-select filtering (supplement §4). */
import { computed, nextTick, onMounted, watch } from 'vue';
import { useRoute, useRouter, type LocationQueryRaw, type LocationQueryValue } from 'vue-router';
import {
  competencyCategory,
  type ExamPart,
  type GradingOrUnseen,
  type SearchResponse,
  type Term,
} from '@qed2/core-logic';
import { GradingDot, HighlightSnippet, QButton, QChip, SearchBox } from '@qed2/ui';
import { useAppStore } from '../stores/app.js';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import FilterDialog, {
  activeFilterCount,
  emptyFilterState,
  GRADING_FILTER_LABELS,
  TEIL_LABELS,
  TERM_LABELS,
  type FilterState,
} from './FilterDialog.vue';

const route = useRoute();
const router = useRouter();
const app = useAppStore();
const progress = useProgressStore();
const practice = usePracticeStore();

const PAGE_SIZE = 100;
const FILTER_QUERY_KEYS = new Set(['year', 'term', 'teil', 'kat', 'grading', 'starred']);
const VALID_TERMS: readonly Term[] = [
  'haupttermin',
  'nebentermin-1',
  'nebentermin-2',
  'herbsttermin',
  'wintertermin',
];
const VALID_TEILS: readonly ExamPart[] = ['t1', 't2'];
const VALID_CATEGORIES: readonly FilterState['categories'][number][] = ['AG', 'FA', 'AN', 'WS'];
const VALID_GRADINGS: readonly GradingOrUnseen[] = [
  'good',
  'careless',
  'meh',
  'baffled',
  'excluded',
  'unseen',
];

const loading = ref(false);
const error = ref<string | undefined>();
const filter = ref<FilterState>(emptyFilterState());
const dialogOpen = ref(false);
let syncingFromRoute = false;

async function load(force = false): Promise<void> {
  if (fetchedOnce && !force && allQuestions.value.length > 0) return;
  loading.value = true;
  error.value = undefined;
  try {
    const first = await app.coreClient.listQuestions({ page: 1, pageSize: PAGE_SIZE });
    let items = first.items;
    let page = 1;
    while (items.length < first.total) {
      page += 1;
      const res = await app.coreClient.listQuestions({ page, pageSize: PAGE_SIZE });
      if (res.items.length === 0) break; // defensive: never loop on a short page
      items = items.concat(res.items);
    }
    allQuestions.value = items;
    fetchedOnce = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function queryStrings(value: LocationQueryValue | LocationQueryValue[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((item) =>
    typeof item === 'string' ? item.split(',').map((part) => part.trim()).filter(Boolean) : [],
  );
}

function uniqueAllowed<T extends string>(
  value: LocationQueryValue | LocationQueryValue[] | undefined,
  allowed: readonly T[],
): T[] {
  const allowedSet = new Set<string>(allowed);
  return [...new Set(queryStrings(value).filter((item): item is T => allowedSet.has(item)))];
}

function parseFilterQuery(): FilterState {
  // Fortschritt linkage: /questions?kat=AG or ?grading=good pre-applies filters.
  const allowedYears = new Set(allQuestions.value.map((q) => q.source.year));
  const years = [...new Set(queryStrings(route.query.year).map(Number))]
    .filter((year) => Number.isInteger(year) && (allowedYears.size === 0 || allowedYears.has(year)))
    .sort((a, b) => a - b);
  return {
    years,
    terms: uniqueAllowed(route.query.term, VALID_TERMS),
    teils: uniqueAllowed(route.query.teil, VALID_TEILS),
    categories: uniqueAllowed(route.query.kat, VALID_CATEGORIES),
    gradings: uniqueAllowed(route.query.grading, VALID_GRADINGS),
    starredOnly: queryStrings(route.query.starred).some((value) => value === '1' || value === 'true'),
  };
}

function filterQuery(f: FilterState): LocationQueryRaw {
  const query: LocationQueryRaw = {};
  for (const [key, value] of Object.entries(route.query)) {
    if (!FILTER_QUERY_KEYS.has(key)) query[key] = value;
  }
  if (f.years.length > 0) query.year = f.years.map(String);
  if (f.terms.length > 0) query.term = [...f.terms];
  if (f.teils.length > 0) query.teil = [...f.teils];
  if (f.categories.length > 0) query.kat = [...f.categories];
  if (f.gradings.length > 0) query.grading = [...f.gradings];
  if (f.starredOnly) query.starred = '1';
  return query;
}

function applyRouteFilters(): void {
  syncingFromRoute = true;
  filter.value = parseFilterQuery();
  void nextTick(() => {
    syncingFromRoute = false;
  });
}

const browseReturnTo = computed(() => router.resolve({ path: '/questions', query: filterQuery(filter.value) }).fullPath);

function practiceQuery(extra: LocationQueryRaw = {}): LocationQueryRaw {
  return { ...extra, returnTo: browseReturnTo.value };
}

watch(
  () => route.query,
  applyRouteFilters,
  { immediate: true },
);

watch(
  filter,
  (next) => {
    if (syncingFromRoute) return;
    const query = filterQuery(next);
    const nextPath = router.resolve({ path: '/questions', query }).fullPath;
    if (nextPath !== route.fullPath) void router.replace({ path: '/questions', query });
  },
  { deep: true },
);

onMounted(() => {
  void load();
});

/* --- global search (search upgrade doc): a separate MODE, independent of
   the chip filters; clearing the query returns to the normal view. --- */
const searchQuery = ref('');
const searchBusy = ref(false);
const searchError = ref<string | undefined>();
const searchResult = ref<SearchResponse | undefined>();
let searchSeq = 0;

const searchMode = computed(() => searchQuery.value.trim() !== '');

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq;
  if (q === '') {
    searchResult.value = undefined;
    searchError.value = undefined;
    searchBusy.value = false;
    return;
  }
  searchBusy.value = true;
  searchError.value = undefined;
  try {
    const res = await app.coreClient.search(q, { limit: 30 });
    if (seq !== searchSeq) return; // a newer query superseded this one
    searchResult.value = res; // core ranks by relevance — never re-sort
  } catch (e) {
    if (seq !== searchSeq) return;
    searchError.value = e instanceof Error ? e.message : String(e);
    searchResult.value = undefined;
  } finally {
    if (seq === searchSeq) searchBusy.value = false;
  }
}

/** Grading dots/star for a search hit need the full part list — resolve from
 *  the already-loaded summaries (search items carry identifiers only). */
const summaryById = computed(() => new Map(allQuestions.value.map((q) => [q.id, q])));

function hitStarred(id: string): boolean {
  const q = summaryById.value.get(id);
  return q?.parts.some((p) => progress.partState.get(p.id)?.starred === true) ?? false;
}

function hitExcluded(id: string): boolean {
  const q = summaryById.value.get(id);
  if (!q || q.parts.length === 0) return false;
  return q.parts.every((p) => (progress.partState.get(p.id)?.grading ?? 'unseen') === 'excluded');
}

function openHit(id: string): void {
  void router.push({ path: '/practice', query: practiceQuery({ questions: id }) });
}

function partGrading(partId: string): GradingOrUnseen {
  return progress.partState.get(partId)?.grading ?? 'unseen';
}

/**
 * Grading semantics: a question matches when ANY part's grading is in the
 * selected set; starredOnly: any part starred.
 */
function matches(q: QuestionSummary, f: FilterState): boolean {
  if (f.years.length > 0 && !f.years.includes(q.source.year)) return false;
  if (f.terms.length > 0 && !f.terms.includes(q.source.term)) return false;
  if (f.teils.length > 0 && !f.teils.includes(q.source.part)) return false;
  if (
    f.categories.length > 0 &&
    !q.parts.some((p) =>
      p.competencies.some((c) => (f.categories as string[]).includes(competencyCategory(c.code))),
    )
  ) {
    return false;
  }
  if (f.gradings.length > 0 && !q.parts.some((p) => f.gradings.includes(partGrading(p.id)))) {
    return false;
  }
  if (f.starredOnly && !q.parts.some((p) => progress.partState.get(p.id)?.starred === true)) {
    return false;
  }
  return true;
}

const filtered = computed(() => allQuestions.value.filter((q) => matches(q, filter.value)));

const filterCount = computed(() => activeFilterCount(filter.value));

/** One removable summary chip per active pick. */
interface ActiveChip {
  key: string;
  label: string;
  remove: () => void;
}

const activeChips = computed<ActiveChip[]>(() => {
  const f = filter.value;
  const out: ActiveChip[] = [];
  for (const y of f.years) {
    out.push({
      key: `y${y}`,
      label: String(y),
      remove: () => (filter.value = { ...f, years: f.years.filter((v) => v !== y) }),
    });
  }
  for (const t of f.terms) {
    out.push({
      key: `t${t}`,
      label: TERM_LABELS[t],
      remove: () => (filter.value = { ...f, terms: f.terms.filter((v) => v !== t) }),
    });
  }
  for (const t of f.teils) {
    out.push({
      key: `p${t}`,
      label: TEIL_LABELS[t],
      remove: () => (filter.value = { ...f, teils: f.teils.filter((v) => v !== t) }),
    });
  }
  for (const c of f.categories) {
    out.push({
      key: `c${c}`,
      label: c,
      remove: () => (filter.value = { ...f, categories: f.categories.filter((v) => v !== c) }),
    });
  }
  for (const g of f.gradings) {
    out.push({
      key: `g${g}`,
      label: GRADING_FILTER_LABELS[g],
      remove: () => (filter.value = { ...f, gradings: f.gradings.filter((v) => v !== g) }),
    });
  }
  if (f.starredOnly) {
    out.push({
      key: 'star',
      label: 'Nur markierte (★)',
      remove: () => (filter.value = { ...f, starredOnly: false }),
    });
  }
  return out;
});

function resetFilters(): void {
  filter.value = emptyFilterState();
}

/** Row summary (feedback #8): points sum instead of a "Teilweise" word. */
interface RowInfo {
  practiced: boolean;
  due: boolean;
  awarded: number;
  allExcluded: boolean;
  starred: boolean;
}

function rowInfo(q: QuestionSummary): RowInfo {
  let practiced = false;
  let due = false;
  let awarded = 0;
  let allExcluded = q.parts.length > 0;
  let starred = false;
  for (const p of q.parts) {
    const s = progress.partState.get(p.id);
    if (s?.practiced) {
      practiced = true;
      awarded += s.awardedPoints;
    }
    if (s?.due) due = true;
    if (s?.starred) starred = true;
    if ((s?.grading ?? 'unseen') !== 'excluded') allExcluded = false;
  }
  return { practiced, due, awarded, allExcluded, starred };
}

/** German decimal comma; trims float noise (rubric halves → "1,5"). */
function fmtPoints(n: number): string {
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

const playableIds = computed(() => filtered.value.filter((q) => q.playable).map((q) => q.id));

const selectedIds = ref<Set<string>>(new Set());

function practiceAll(): void {
  const targets = selectedIds.value.size > 0 ? Array.from(selectedIds.value) : playableIds.value;
  if (targets.length === 0) return;
  // Store handoff instead of ?questions=<hundreds of ids>: the session is
  // seeded here, /practice mounts onto it (PracticeView keeps loading/running).
  void practice.startPrepared(targets);
  void router.push({ path: '/practice', query: practiceQuery() });
}

function practiceSingle(id: string): void {
  void practice.startPrepared([id]);
  void router.push({ path: '/practice', query: practiceQuery() });
}

function toggleSelection(q: QuestionSummary): void {
  if (!q.playable) return;
  const next = new Set(selectedIds.value);
  if (next.has(q.id)) next.delete(q.id);
  else next.add(q.id);
  selectedIds.value = next;
}

function firstCode(q: QuestionSummary): string | undefined {
  return q.parts[0]?.competencies[0]?.code;
}
</script>

<template>
  <div class="browse">
    <div class="browse__sticky-header">
      <div class="browse__head">
        <h1 class="browse__title">Aufgaben</h1>
        <QButton :disabled="playableIds.length === 0" @click="practiceAll">Auswahl üben →</QButton>
      </div>

      <SearchBox
        v-model="searchQuery"
        class="browse__search"
        placeholder="Aufgaben durchsuchen — Titel, Kompetenz, Angabe, Lösung …"
        :busy="searchBusy"
        @search="runSearch"
      />

      <div v-if="!searchMode" class="browse__filterbar">
        <button
          type="button"
          class="browse__filterbtn"
          :aria-expanded="dialogOpen ? 'true' : 'false'"
          @click="dialogOpen = true"
        >
          <svg class="browse__funnel" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M1 1.5h10L7.5 6v4L4.5 8.5V6L1 1.5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
          Filter
          <span v-if="filterCount > 0" class="browse__badge">{{ filterCount }}</span>
        </button>

        <span v-for="chip in activeChips" :key="chip.key" class="browse__active">
          {{ chip.label }}
          <button
            type="button"
            class="browse__active-x"
            :aria-label="`Filter ${chip.label} entfernen`"
            @click="chip.remove()"
          >
            ✕
          </button>
        </span>

        <button v-if="filterCount > 0" type="button" class="browse__reset" @click="resetFilters">
          Zurücksetzen
        </button>
      </div>
    </div>

    <!-- search mode: an independent view; clearing returns to browse -->
    <template v-if="searchMode">
      <div class="browse__meta">
        <span v-if="searchBusy">Suche …</span>
        <span v-else-if="searchResult">{{ searchResult.total }} Treffer für „{{ searchResult.query }}“</span>
      </div>
      <div v-if="searchError" class="browse__error">
        Suche fehlgeschlagen: {{ searchError }}
      </div>
      <div v-else-if="searchResult && searchResult.items.length === 0 && !searchBusy" class="browse__empty">
        Keine Treffer — Tippfehler sind erlaubt, aber probier ein anderes Wort.
      </div>
      <div v-else-if="searchResult" class="browse__list">
        <button
          v-for="hit in searchResult.items"
          :key="hit.id"
          type="button"
          class="browse__row browse__hit"
          :class="{ 'browse__row--excluded': hitExcluded(hit.id) }"
          @click="openHit(hit.id)"
        >
          <span class="browse__dots" aria-hidden="false">
            <GradingDot
              v-for="p in summaryById.get(hit.id)?.parts ?? []"
              :key="p.id"
              :grading="partGrading(p.id)"
              :size="11"
            />
          </span>
          <span class="browse__hit-main">
            <span class="browse__hit-title">
              {{ hit.title }}
              <span v-if="hitStarred(hit.id)" class="browse__star" title="Gemerkt">★</span>
              <span v-if="hitExcluded(hit.id)" class="browse__excl" title="Ausgeschlossen">⊗</span>
            </span>
            <span class="browse__hit-source">
              {{ hit.source.year }} · {{ TERM_LABELS[hit.source.term] }} · {{ hit.source.part === 't1' ? 'Teil 1' : 'Teil 2' }} · Nr. {{ hit.source.nr }}
            </span>
            <HighlightSnippet
              v-if="hit.highlights[0]"
              :snippet="hit.highlights[0]!.snippet"
              class="browse__hit-snippet"
            />
          </span>
        </button>
      </div>
    </template>

    <div v-if="!searchMode" class="browse__meta">
      <span v-if="!loading">{{ filtered.length }} Aufgaben</span>
      <span v-else>Lade …</span>
    </div>

    <div v-if="!searchMode && error" class="browse__error">
      Aufgabenliste konnte nicht geladen werden: {{ error }}
      <QButton variant="secondary" @click="load(true)">Erneut versuchen</QButton>
    </div>

    <div v-else-if="!searchMode && loading && allQuestions.length === 0" class="browse__list">
      <div v-for="i in 6" :key="i" class="browse__skeleton" />
    </div>

    <div v-else-if="!searchMode && filtered.length === 0" class="browse__empty">Keine Aufgaben für diese Filter.</div>

    <div v-else-if="!searchMode" class="browse__list">
      <button
        v-for="q in filtered"
        :key="q.id"
        type="button"
        class="browse__row"
        :class="{
          'browse__row--disabled': !q.playable,
          'browse__row--excluded': rowInfo(q).allExcluded,
          'browse__row--selected': selectedIds.has(q.id)
        }"
        :disabled="!q.playable"
        @click="toggleSelection(q)"
        @dblclick="q.playable && practiceSingle(q.id)"
      >
        <span class="browse__dots" aria-hidden="false">
          <GradingDot v-for="p in q.parts" :key="p.id" :grading="partGrading(p.id)" :size="11" />
        </span>
        <span class="browse__nr">{{ q.source.nr }}</span>
        <QChip v-if="firstCode(q)" class="browse__chip">{{ firstCode(q) }}</QChip>
        <span
          v-if="rowInfo(q).allExcluded"
          class="browse__excl"
          title="Ausgeschlossen"
          aria-label="Ausgeschlossen"
          >⊗</span
        >
        <span class="browse__qtitle">{{ q.title }}</span>
        <span v-if="rowInfo(q).starred" class="browse__star" title="Gemerkt" aria-label="Gemerkt">★</span>

        <span v-if="!q.playable" class="browse__state browse__state--na">Noch nicht verfügbar</span>
        <template v-else-if="rowInfo(q).practiced">
          <span v-if="rowInfo(q).due" class="browse__due">
            <span class="browse__due-dot" aria-hidden="true" />Fällig
          </span>
          <span class="browse__points">
            {{ fmtPoints(rowInfo(q).awarded) }}/{{ fmtPoints(q.totalPoints) }} P
          </span>
        </template>
        <span v-else class="browse__state browse__state--new">Neu</span>

        <Transition name="pop-in">
          <span
            v-if="selectedIds.has(q.id) && selectedIds.size === 1"
            role="button"
            class="browse__single-btn"
            title="Diese Aufgabe üben"
            @click.stop="practiceSingle(q.id)"
          >
            →
          </span>
        </Transition>
      </button>
    </div>

    <FilterDialog
      v-if="dialogOpen"
      v-model="filter"
      :result-count="filtered.length"
      @close="dialogOpen = false"
    />
  </div>
</template>

<style scoped>
.browse {
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.browse__sticky-header {
  position: sticky;
  /* .app__main already carries the safe-area inset as padding; resting the
     header at that offset (instead of padding it in again) avoids a double
     inset — the app-shell scrim covers the status-bar strip when stuck. */
  top: env(safe-area-inset-top);
  z-index: 10;
  background: var(--q-page);
  margin: -26px -20px 10px;
  padding: 26px 20px 10px;
  border-bottom: 1px solid var(--q-border-soft);
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
.browse__search {
  margin-bottom: 12px;
}
.browse__star {
  color: var(--q-part);
  font-size: 14px;
  flex: none;
  line-height: 1;
}
.browse__hit {
  align-items: flex-start;
}
.browse__hit-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
}
.browse__hit-title {
  font-size: 13.5px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 7px;
}
.browse__hit-source {
  font-size: 11px;
  color: var(--q-faint);
}
.browse__hit-snippet {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.browse__filterbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 10px;
}
.browse__filterbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 20px;
  border: 1px solid var(--q-border-3);
  background: var(--q-card);
  color: var(--q-ink-2);
  font: 700 12.5px 'Public Sans', system-ui, sans-serif;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .browse__filterbtn:hover {
    border-color: var(--q-accent);
  }
}
.browse__filterbtn:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.browse__funnel {
  flex: none;
  color: var(--q-mut-2);
}
.browse__badge {
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-size: 10.5px;
  font-weight: 800;
  display: inline-grid;
  place-items: center;
}
.browse__active {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 10px;
  border-radius: 20px;
  border: 1px solid var(--q-accent);
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.browse__active-x {
  border: none;
  background: none;
  color: var(--q-mut-2);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 50%;
  font-family: inherit;
  line-height: 1;
}
@media (hover: hover) and (pointer: fine) {
  .browse__active-x:hover {
    color: var(--q-err);
  }
}
.browse__active-x:focus-visible {
  outline: 2px solid var(--q-accent);
}
.browse__reset {
  border: none;
  background: none;
  font-size: 12px;
  color: var(--q-mut-2);
  cursor: pointer;
  padding: 6px 8px;
  font-family: inherit;
  font-weight: 600;
}
@media (hover: hover) and (pointer: fine) {
  .browse__reset:hover {
    color: var(--q-ink);
  }
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
  gap: 12px;
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
.browse__row--selected {
  background: var(--q-accent-bg);
  border-color: var(--q-accent);
}
@media (hover: hover) and (pointer: fine) {
  .browse__row:hover:not(:disabled) {
    border-color: var(--q-accent);
  }
  .browse__row--selected:hover:not(:disabled) {
    border-color: var(--q-accent-strong, var(--q-accent));
  }
}
.browse__row:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.browse__row--disabled {
  opacity: 0.55;
  cursor: default;
}
/* All parts excluded: greyed but still clickable (§1.4 — not deletion). */
.browse__row--excluded {
  opacity: 0.5;
}
.browse__dots {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.browse__nr {
  font-weight: 700;
  font-size: 13.5px;
  min-width: 26px;
  flex: none;
}
.browse__excl {
  color: var(--q-neutral);
  font-size: 13px;
  font-weight: 700;
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
.browse__points {
  font-family: ui-monospace, Menlo, monospace;
  font-weight: 700;
  font-size: 12.5px;
  flex: none;
  margin-left: auto;
}
.browse__due {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 700;
  color: var(--q-accent-strong);
  flex: none;
  margin-left: auto;
}
.browse__due + .browse__points {
  margin-left: 0;
}
.browse__due-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--q-accent);
  flex: none;
}
.browse__state {
  font-size: 11px;
  flex: none;
  margin-left: auto;
}
.browse__single-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 800;
  font-size: 14px;
  margin-left: 8px;
  flex: none;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}
.pop-in-enter-active,
.pop-in-leave-active {
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.pop-in-enter-from,
.pop-in-leave-to {
  opacity: 0;
  transform: scale(0.6) translateX(-10px);
}
@media (hover: hover) and (pointer: fine) {
  .browse__single-btn:hover {
    background: var(--q-ink);
    transform: translateX(2px);
  }
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
@media (max-width: 640px) {
  .browse__qtitle {
    display: none;
  }
}
@media (max-width: 420px) {
  .browse__chip {
    display: none;
  }
  .browse__row {
    gap: 9px;
  }
}
</style>
