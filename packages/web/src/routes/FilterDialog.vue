<script lang="ts">
import type { ExamPart, GradingOrUnseen, Term } from '@qed2/core-logic';

/**
 * Multi-select filter state for the Aufgaben browse view (supplement §4).
 * Empty array = no restriction on that dimension; `starredOnly` narrows to
 * questions with at least one starred part.
 */
export interface FilterState {
  years: number[];
  terms: Term[];
  teils: ExamPart[];
  categories: ('AG' | 'FA' | 'AN' | 'WS')[];
  gradings: GradingOrUnseen[];
  /** Official Antwortformat strings (e.g. „Zuordnungsaufgabe") — the summary
   *  carries them verbatim, so this filter is entirely client-side. */
  formats: string[];
  starredOnly: boolean;
}

export function emptyFilterState(): FilterState {
  return { years: [], terms: [], teils: [], categories: [], gradings: [], formats: [], starredOnly: false };
}

/** Total number of active picks — drives the badge and the summary chips. */
export function activeFilterCount(f: FilterState): number {
  return (
    f.years.length +
    f.terms.length +
    f.teils.length +
    f.categories.length +
    f.gradings.length +
    f.formats.length +
    (f.starredOnly ? 1 : 0)
  );
}

export const TERM_LABELS: Record<Term, string> = {
  haupttermin: 'Haupttermin',
  'nebentermin-1': 'Nebentermin 1',
  'nebentermin-2': 'Nebentermin 2',
  herbsttermin: 'Herbsttermin',
  wintertermin: 'Wintertermin',
};

export const TEIL_LABELS: Record<ExamPart, string> = { t1: 'Teil 1', t2: 'Teil 2' };

/** Same German strings as GRADING_LABELS in @qed2/ui GradingDot. */
export const GRADING_FILTER_LABELS: Record<GradingOrUnseen, string> = {
  good: 'Gut',
  careless: 'Schlampigkeitsfehler',
  meh: 'Halb verstanden',
  baffled: 'Keine Ahnung',
  excluded: 'Ausgeschlossen',
  unseen: 'Neu',
};
</script>

<script setup lang="ts">
/**
 * Filter modal for the Aufgaben list — every dimension is multi-select
 * (toggle chips). The parent owns the data and computes `resultCount`
 * reactively; each toggle emits a fresh FilterState via update:modelValue.
 * Bewertung includes `unseen` — "nur ungesehene" is a valid filter.
 */
import { computed, ref } from 'vue';
import { GradingDot, QButton } from '@qed2/ui';
import { useModalA11y } from '../composables/useModalA11y.js';

const props = withDefaults(
  defineProps<{
    modelValue: FilterState;
    /** Questions matching the current draft — computed by the parent. */
    resultCount: number;
    /** Years actually present in the question pool; defaults to every year
     *  from 2014 (first SRDP exam) through the current one. */
    years?: number[];
    /** Aufgabenformat values present in the pool (from part summaries). */
    formats?: string[];
  }>(),
  { years: undefined, formats: undefined },
);

const emit = defineEmits<{
  'update:modelValue': [f: FilterState];
  close: [];
}>();

/* Mount-based dialog: always "open" while it exists. */
const card = ref<HTMLElement | null>(null);
useModalA11y(card, ref(true), () => emit('close'));

const YEARS = computed(() => {
  if (props.years && props.years.length > 0) return [...props.years].sort((a, b) => b - a);
  const current = new Date().getFullYear();
  return Array.from({ length: current - 2014 + 1 }, (_, i) => current - i);
});
const TERMS: readonly Term[] = [
  'haupttermin',
  'nebentermin-1',
  'nebentermin-2',
  'herbsttermin',
  'wintertermin',
];
const TEILS: readonly ExamPart[] = ['t1', 't2'];
const CATEGORIES = ['AG', 'FA', 'AN', 'WS'] as const;
const GRADINGS: readonly GradingOrUnseen[] = [
  'good',
  'careless',
  'meh',
  'baffled',
  'excluded',
  'unseen',
];

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function toggleYear(y: number): void {
  emit('update:modelValue', { ...props.modelValue, years: toggled(props.modelValue.years, y) });
}
function toggleTerm(t: Term): void {
  emit('update:modelValue', { ...props.modelValue, terms: toggled(props.modelValue.terms, t) });
}
function toggleTeil(t: ExamPart): void {
  emit('update:modelValue', { ...props.modelValue, teils: toggled(props.modelValue.teils, t) });
}
function toggleCategory(c: 'AG' | 'FA' | 'AN' | 'WS'): void {
  emit('update:modelValue', {
    ...props.modelValue,
    categories: toggled(props.modelValue.categories, c),
  });
}
function toggleGrading(g: GradingOrUnseen): void {
  emit('update:modelValue', {
    ...props.modelValue,
    gradings: toggled(props.modelValue.gradings, g),
  });
}
function toggleFormat(f: string): void {
  emit('update:modelValue', {
    ...props.modelValue,
    formats: toggled(props.modelValue.formats, f),
  });
}
function toggleStarred(): void {
  emit('update:modelValue', { ...props.modelValue, starredOnly: !props.modelValue.starredOnly });
}

function reset(): void {
  emit('update:modelValue', emptyFilterState());
}

function onBackdropClick(ev: MouseEvent): void {
  if (ev.target === ev.currentTarget) emit('close');
}

const countText = computed(() =>
  props.resultCount === 1 ? '1 Aufgabe entspricht' : `${props.resultCount} Aufgaben entsprechen`,
);
</script>

<template>
  <Teleport to="body">
    <div class="fdlg q-modal-backdrop" role="dialog" aria-modal="true" aria-label="Filter" @click="onBackdropClick">
      <div ref="card" class="fdlg__card">
        <div class="fdlg__head">
          <h2 class="fdlg__title">Filter</h2>
          <button type="button" class="q-dialog-close" aria-label="Schließen" data-autofocus @click="emit('close')">
            ✕
          </button>
        </div>

        <div class="fdlg__body">
          <section class="fdlg__section">
            <div class="fdlg__label">Jahr</div>
            <div class="fdlg__chips">
              <button
                v-for="y in YEARS"
                :key="y"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.years.includes(y) }"
                :aria-pressed="modelValue.years.includes(y) ? 'true' : 'false'"
                @click="toggleYear(y)"
              >
                <span v-if="modelValue.years.includes(y)" class="fdlg__tick" aria-hidden="true">✓</span>
                {{ y }}
              </button>
            </div>
          </section>

          <section class="fdlg__section">
            <div class="fdlg__label">Termin</div>
            <div class="fdlg__chips">
              <button
                v-for="t in TERMS"
                :key="t"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.terms.includes(t) }"
                :aria-pressed="modelValue.terms.includes(t) ? 'true' : 'false'"
                @click="toggleTerm(t)"
              >
                <span v-if="modelValue.terms.includes(t)" class="fdlg__tick" aria-hidden="true">✓</span>
                {{ TERM_LABELS[t] }}
              </button>
            </div>
          </section>

          <section class="fdlg__section">
            <div class="fdlg__label">Teil</div>
            <div class="fdlg__chips">
              <button
                v-for="t in TEILS"
                :key="t"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.teils.includes(t) }"
                :aria-pressed="modelValue.teils.includes(t) ? 'true' : 'false'"
                @click="toggleTeil(t)"
              >
                <span v-if="modelValue.teils.includes(t)" class="fdlg__tick" aria-hidden="true">✓</span>
                {{ TEIL_LABELS[t] }}
              </button>
            </div>
          </section>

          <section class="fdlg__section">
            <div class="fdlg__label">Kompetenz</div>
            <div class="fdlg__chips">
              <button
                v-for="c in CATEGORIES"
                :key="c"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.categories.includes(c) }"
                :aria-pressed="modelValue.categories.includes(c) ? 'true' : 'false'"
                @click="toggleCategory(c)"
              >
                <span v-if="modelValue.categories.includes(c)" class="fdlg__tick" aria-hidden="true">✓</span>
                {{ c }}
              </button>
            </div>
          </section>

          <section class="fdlg__section">
            <div class="fdlg__label">Bewertung</div>
            <div class="fdlg__chips">
              <button
                v-for="g in GRADINGS"
                :key="g"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.gradings.includes(g) }"
                :aria-pressed="modelValue.gradings.includes(g) ? 'true' : 'false'"
                @click="toggleGrading(g)"
              >
                <span v-if="modelValue.gradings.includes(g)" class="fdlg__tick" aria-hidden="true">✓</span>
                <GradingDot :grading="g" :size="12" />
                {{ GRADING_FILTER_LABELS[g] }}
              </button>
            </div>
          </section>

          <section v-if="formats && formats.length > 0" class="fdlg__section">
            <div class="fdlg__label">Aufgabenformat</div>
            <div class="fdlg__chips">
              <button
                v-for="f in formats"
                :key="f"
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.formats.includes(f) }"
                :aria-pressed="modelValue.formats.includes(f) ? 'true' : 'false'"
                @click="toggleFormat(f)"
              >
                <span v-if="modelValue.formats.includes(f)" class="fdlg__tick" aria-hidden="true">✓</span>
                {{ f }}
              </button>
            </div>
          </section>

          <section class="fdlg__section">
            <div class="fdlg__label">Merkliste</div>
            <div class="fdlg__chips">
              <button
                type="button"
                class="fdlg__chip"
                :class="{ 'fdlg__chip--on': modelValue.starredOnly }"
                :aria-pressed="modelValue.starredOnly ? 'true' : 'false'"
                @click="toggleStarred"
              >
                <span v-if="modelValue.starredOnly" class="fdlg__tick" aria-hidden="true">✓</span>
                Nur markierte (★)
              </button>
            </div>
          </section>
        </div>

        <div class="fdlg__footer">
          <span class="fdlg__count" aria-live="polite">{{ countText }}</span>
          <QButton variant="ghost" @click="reset">Zurücksetzen</QButton>
          <QButton @click="emit('close')">Fertig</QButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fdlg {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
}
.fdlg__card {
  width: 100%;
  max-width: 560px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
  overflow: hidden;
}
.fdlg__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 10px;
  flex: none;
}
.fdlg__title {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.01em;
  margin: 0;
}
.fdlg__body {
  overflow-y: auto;
  padding: 0 22px 12px;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.fdlg__section {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.fdlg__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.fdlg__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fdlg__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 20px;
  border: 1px solid var(--q-border-3);
  background: var(--q-card);
  color: var(--q-ink-2);
  font: 600 12px 'Public Sans', system-ui, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .fdlg__chip:hover {
    border-color: var(--q-accent);
  }
}
.fdlg__chip:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.fdlg__chip--on {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-weight: 700;
}
@media (pointer: coarse) {
  .fdlg__chips {
    gap: 8px;
  }
  .fdlg__chip {
    min-height: 44px;
    padding: 10px 14px;
  }
}
.fdlg__tick {
  color: var(--q-accent-strong);
  font-weight: 800;
  font-size: 11px;
}
.fdlg__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  border-top: 1px solid var(--q-border);
  background: var(--q-panel);
  flex: none;
  flex-wrap: wrap;
}
.fdlg__count {
  flex: 1;
  min-width: 120px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--q-mut);
}
</style>
