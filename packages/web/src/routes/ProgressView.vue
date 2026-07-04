<script setup lang="ts">
/**
 * Fortschritt / Beherrschung (prototype 3c, mobile 5d; supplement §5):
 * stats band, grading-state distribution, activity heatmap, per-category
 * mastery table, then the full competency groups. All visualizations are
 * shared @qed2/ui components (dashboard reuses them, §8).
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { competencyCategory } from '@qed2/core-logic';
import {
  ActivityHeatmap,
  CompetencyGroups,
  GradingDistribution,
  MasteryBar,
  RadarChart,
  type RadarAxis,
} from '@qed2/ui';
import { historyLog } from '../services.js';
import { useProgressStore } from '../stores/progress.js';

const router = useRouter();
const progress = useProgressStore();

// Per-competency due flags need the part→competency map, which the archive
// deliberately does not carry (contract stores only codes+mastery). v1 shows
// the global due count in the stats band instead.
const entries = computed(() =>
  progress.masteryEntries.map((e) => ({ code: e.code, mastery: e.mastery, due: false })),
);

const avgMastery = computed(() => {
  const list = progress.masteryEntries;
  if (list.length === 0) return 0;
  return Math.round((list.reduce((s, e) => s + e.mastery, 0) / list.length) * 100);
});

/** Heatmap feed (26 weeks = 182 days) — re-queried when the log changes. */
const activity = ref<Record<string, number>>({});
watch(
  () => progress.historyVersion,
  async () => {
    activity.value = await historyLog.dailyActivity(182, new Date());
  },
  { immediate: true },
);

/** Per-category rollup: competency count + average mastery per AG/FA/AN/WS. */
const CATEGORY_ORDER = ['AG', 'FA', 'AN', 'WS'] as const;
const CATEGORY_NAMES: Record<(typeof CATEGORY_ORDER)[number], string> = {
  AG: 'Algebra & Geometrie',
  FA: 'Funktionale Abhängigkeiten',
  AN: 'Analysis',
  WS: 'Wahrscheinlichkeit & Statistik',
};

/** Radar over the four Kompetenz categories (0 for untouched ones). */
const radarAxes = computed<RadarAxis[]>(() => {
  const groups = new Map<string, number[]>();
  for (const e of progress.masteryEntries) {
    const cat = competencyCategory(e.code);
    if (cat === 'other') continue;
    const list = groups.get(cat) ?? [];
    list.push(e.mastery);
    groups.set(cat, list);
  }
  return CATEGORY_ORDER.map((c) => {
    const list = groups.get(c);
    const avg = list && list.length > 0 ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    return { label: c, value: avg, hint: `${Math.round(avg * 100)} %` };
  });
});

/** Category → Aufgaben with that Kompetenz filter pre-applied. */
function openCategory(code: string): void {
  void router.push({ path: '/questions', query: { kat: code } });
}

const categoryRows = computed(() => {
  const groups = new Map<string, number[]>();
  for (const e of progress.masteryEntries) {
    const cat = competencyCategory(e.code);
    if (cat === 'other') continue;
    const list = groups.get(cat) ?? [];
    list.push(e.mastery);
    groups.set(cat, list);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => {
    const list = groups.get(c)!;
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    return {
      code: c,
      name: CATEGORY_NAMES[c],
      count: list.length,
      avg,
      percent: Math.round(avg * 100),
    };
  });
});
</script>

<template>
  <div class="prog">
    <div class="prog__head">
      <h1 class="prog__title">Fortschritt</h1>
      <div class="prog__legend">
        <span class="prog__legend-item"><span class="prog__sq prog__sq--ok" />hoch</span>
        <span class="prog__legend-item"><span class="prog__sq prog__sq--part" />mittel</span>
        <span class="prog__legend-item"><span class="prog__sq prog__sq--low" />gering</span>
      </div>
    </div>

    <div class="prog__stats">
      <div class="prog__stat">
        <div class="prog__stat-num">{{ progress.practicedParts }}</div>
        <div class="prog__stat-label">Bearbeitete Teile</div>
      </div>
      <div class="prog__stat">
        <div class="prog__stat-num">{{ progress.dueCount }}</div>
        <div class="prog__stat-label">Fällig heute</div>
      </div>
      <div class="prog__stat">
        <div class="prog__stat-num">{{ avgMastery }} %</div>
        <div class="prog__stat-label">Ø Beherrschung</div>
      </div>
    </div>

    <!-- grading-state distribution (supplement §5). The unseen count needs
         the bank's total PART count, which /info does not expose — omitted. -->
    <div class="prog__duo">
      <section class="prog__section">
        <h2 class="prog__section-title">Beherrschung nach Status</h2>
        <GradingDistribution :counts="progress.gradingCounts" />
      </section>
      <section class="prog__section">
        <h2 class="prog__section-title">Kompetenz-Radar</h2>
        <RadarChart :axes="radarAxes" />
      </section>
    </div>

    <section class="prog__section">
      <h2 class="prog__section-title">Aktivität</h2>
      <ActivityHeatmap :data="activity" :weeks="26" />
    </section>

    <section v-if="categoryRows.length > 0" class="prog__section">
      <h2 class="prog__section-title">Nach Bereich</h2>
      <div class="prog__table-scroll">
        <table class="prog__table">
          <thead>
            <tr>
              <th scope="col">Bereich</th>
              <th scope="col" class="prog__table-num">Kompetenzen</th>
              <th scope="col" class="prog__table-num">Ø Beherrschung</th>
              <th scope="col" class="prog__table-bar">Verlauf</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in categoryRows"
              :key="row.code"
              class="prog__table-row--link"
              role="link"
              tabindex="0"
              :title="`Aufgaben mit ${row.code} anzeigen`"
              @click="openCategory(row.code)"
              @keydown.enter="openCategory(row.code)"
            >
              <td>
                <span class="prog__cat-code">{{ row.code }}</span>
                <span class="prog__cat-name">{{ row.name }}</span>
                <span class="prog__cat-go" aria-hidden="true">→</span>
              </td>
              <td class="prog__table-num">{{ row.count }}</td>
              <td class="prog__table-num">{{ row.percent }} %</td>
              <td class="prog__table-bar"><MasteryBar :code="row.code" :mastery="row.avg" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <CompetencyGroups v-if="entries.length > 0" :entries="entries" />
    <div v-else class="prog__empty">
      Noch kein Fortschritt — starte deine erste Sitzung.
      <RouterLink to="/practice" class="prog__cta">Intelligent üben →</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.prog {
  max-width: 720px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.prog__head {
  margin-bottom: 16px;
}
.prog__title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0 0 10px;
}
.prog__legend {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.prog__legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--q-mut);
}
.prog__sq {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.prog__sq--ok {
  background: var(--q-ok);
}
.prog__sq--part {
  background: var(--q-part);
}
.prog__sq--low {
  background: var(--q-mut-2);
}
.prog__stats {
  display: flex;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.prog__stat {
  flex: 1;
  min-width: 120px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  padding: 14px 16px;
}
.prog__stat-num {
  font-weight: 800;
  font-size: 24px;
}
.prog__stat-label {
  font-size: 11px;
  color: var(--q-faint);
  margin-top: 2px;
}
.prog__section {
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 18px;
}
.prog__section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin: 0 0 12px;
}
.prog__duo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
@media (max-width: 640px) {
  .prog__duo {
    grid-template-columns: 1fr;
  }
}
.prog__table-row--link {
  cursor: pointer;
}
.prog__table-row--link:hover td,
.prog__table-row--link:focus-visible td {
  background: var(--q-panel);
}
.prog__table-row--link:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}
.prog__cat-go {
  margin-left: 8px;
  color: var(--q-accent-strong);
  font-weight: 700;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.prog__table-row--link:hover .prog__cat-go {
  opacity: 1;
}
.prog__table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.prog__table {
  width: 100%;
  min-width: 460px;
  border-collapse: collapse;
  font-size: 12.5px;
}
.prog__table th {
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  color: var(--q-faint);
  padding: 0 10px 8px 0;
  border-bottom: 1px solid var(--q-border);
}
.prog__table td {
  padding: 9px 10px 9px 0;
  border-bottom: 1px solid var(--q-border-soft);
  vertical-align: middle;
}
.prog__table tr:last-child td {
  border-bottom: none;
}
.prog__table-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.prog__table th.prog__table-num {
  text-align: right;
}
.prog__table-bar {
  width: 38%;
  min-width: 150px;
}
.prog__cat-code {
  font-weight: 800;
  color: var(--q-accent-strong);
  margin-right: 8px;
}
.prog__cat-name {
  color: var(--q-mut);
}
.prog__empty {
  padding: 32px 20px;
  text-align: center;
  color: var(--q-mut-2);
  font-size: 13.5px;
  background: var(--q-panel);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.prog__cta {
  font-weight: 700;
  color: var(--q-accent-strong);
  text-decoration: none;
}
</style>
