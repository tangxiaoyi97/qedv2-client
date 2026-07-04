<script setup lang="ts">
/**
 * Fortschritt / Beherrschung (prototype 3c, mobile 5d; supplement §5):
 * stats band, grading-state distribution, activity heatmap, per-category
 * mastery table, then the full competency groups. All visualizations are
 * shared @qed2/ui components (dashboard reuses them, §8).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  competencyCategory,
  type Grading,
  type GradingOrUnseen,
  type HistoryEntry,
  type QuestionSummary,
} from '@qed2/core-logic';
import {
  ActivityHeatmap,
  CompetencyGroups,
  GradingDot,
  GradingDistribution,
  MasteryBar,
  RadarChart,
  type RadarAxis,
} from '@qed2/ui';
import { historyLog } from '../services.js';
import { useAppStore } from '../stores/app.js';
import { useProgressStore } from '../stores/progress.js';

const router = useRouter();
const app = useAppStore();
const progress = useProgressStore();

const GRADING_LABELS: Record<GradingOrUnseen, string> = {
  good: 'Gut',
  careless: 'Schlampigkeitsfehler',
  meh: 'Halb verstanden',
  baffled: 'Keine Ahnung',
  excluded: 'Ausgeschlossen',
  unseen: 'Neu',
};
const GRADING_ORDER: readonly Grading[] = ['good', 'careless', 'meh', 'baffled', 'excluded'];

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
const selectedActivityDate = ref<string | null>(null);
const selectedDayEntries = ref<HistoryEntry[]>([]);

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function formatDayKey(key: string | null): string {
  if (!key) return 'Kein Tag ausgewählt';
  return new Intl.DateTimeFormat('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(
    parseDayKey(key),
  );
}

const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });

async function selectActivityDay(day: string): Promise<void> {
  selectedActivityDate.value = day;
  selectedDayEntries.value = await historyLog.listByLocalDay(day);
}

async function refreshActivity(): Promise<void> {
  const next = await historyLog.dailyActivity(182, new Date());
  activity.value = next;
  const activeDays = Object.entries(next)
    .filter(([, count]) => count > 0)
    .map(([day]) => day)
    .sort();
  if (!selectedActivityDate.value && activeDays.length > 0) {
    await selectActivityDay(activeDays[activeDays.length - 1]!);
  } else if (selectedActivityDate.value) {
    await selectActivityDay(selectedActivityDate.value);
  }
}

watch(
  () => progress.historyVersion,
  () => void refreshActivity(),
  { immediate: true },
);

const selectedDayGradingCounts = computed(() => {
  const counts: Record<Grading, number> = { good: 0, careless: 0, meh: 0, baffled: 0, excluded: 0 };
  for (const entry of selectedDayEntries.value) counts[entry.grading] += 1;
  return counts;
});

const selectedDayRows = computed(() =>
  GRADING_ORDER.map((grading) => ({
    grading,
    label: GRADING_LABELS[grading],
    count: selectedDayGradingCounts.value[grading],
  })),
);

const activityTotal = computed(() =>
  Object.values(activity.value).reduce((sum, count) => sum + count, 0),
);
const activeDayCount = computed(() =>
  Object.values(activity.value).filter((count) => count > 0).length,
);
const selectedDayPoints = computed(() => ({
  awarded: selectedDayEntries.value.reduce((sum, entry) => sum + entry.awardedPoints, 0),
  max: selectedDayEntries.value.reduce((sum, entry) => sum + entry.maxPoints, 0),
}));

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

function openStatusFilter(state: GradingOrUnseen): void {
  void router.push({ path: '/questions', query: { grading: state } });
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

interface PartMeta {
  questionId: string;
  title: string;
  partLabel: string | undefined;
  codes: string[];
}

const partMeta = ref<Map<string, PartMeta>>(new Map());
const partMetaLoaded = ref(false);

async function loadPartMeta(): Promise<void> {
  if (partMetaLoaded.value) return;
  const PAGE_SIZE = 100;
  try {
    const first = await app.coreClient.listQuestions({ page: 1, pageSize: PAGE_SIZE });
    let items: QuestionSummary[] = first.items;
    let page = 1;
    while (items.length < first.total) {
      page += 1;
      const res = await app.coreClient.listQuestions({ page, pageSize: PAGE_SIZE });
      if (res.items.length === 0) break;
      items = items.concat(res.items);
    }
    const next = new Map<string, PartMeta>();
    for (const q of items) {
      const multi = q.parts.length > 1;
      for (const p of q.parts) {
        next.set(p.id, {
          questionId: q.id,
          title: q.title,
          partLabel: multi ? p.label : undefined,
          codes: p.competencies.map((c) => c.code),
        });
      }
    }
    partMeta.value = next;
    partMetaLoaded.value = true;
  } catch {
    partMetaLoaded.value = true;
  }
}

onMounted(() => void loadPartMeta());

const statusRows = computed(() =>
  progress.archive.content.perPart
    .filter((part) => part.grading != null)
    .map((part) => {
      const meta = partMeta.value.get(part.partId);
      return {
        partId: part.partId,
        grading: part.grading!,
        title: meta?.title ?? part.partId,
        partLabel: meta?.partLabel,
        codes: meta?.codes ?? [],
        updatedAt: part.updatedAt,
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
);

const statusGroups = computed(() =>
  GRADING_ORDER.map((grading) => {
    const rows = statusRows.value.filter((row) => row.grading === grading);
    return { grading, label: GRADING_LABELS[grading], rows };
  }),
);

const gradedPartCount = computed(() =>
  Object.values(progress.gradingCounts).reduce((sum, count) => sum + count, 0),
);
const bankPartCount = computed(() => partMeta.value.size);
const allBankUnseenCount = computed(() => Math.max(0, bankPartCount.value - gradedPartCount.value));
const statusRadarAxes = computed<RadarAxis[]>(() => {
  const rows: Array<{ label: string; count: number }> = [
    { label: 'Gut', count: progress.gradingCounts.good },
    { label: 'Schlampig', count: progress.gradingCounts.careless },
    { label: 'Halb', count: progress.gradingCounts.meh },
    { label: 'Keine', count: progress.gradingCounts.baffled },
    { label: 'Ausg.', count: progress.gradingCounts.excluded },
    { label: 'Neu', count: allBankUnseenCount.value },
  ];
  const total = Math.max(1, rows.reduce((sum, row) => sum + row.count, 0));
  return rows.map((row) => {
    const percent = Math.round((row.count / total) * 100);
    return { label: row.label, value: row.count / total, hint: `${row.count} · ${percent} %` };
  });
});

const categoryDetailGroups = computed(() =>
  CATEGORY_ORDER.map((category) => {
    const rows = progress.masteryEntries
      .filter((entry) => competencyCategory(entry.code) === category)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((entry) => ({
        code: entry.code,
        mastery: entry.mastery,
        percent: Math.round(entry.mastery * 100),
      }));
    return { code: category, name: CATEGORY_NAMES[category], rows };
  }).filter((group) => group.rows.length > 0),
);

type DetailKind = 'status' | 'activity' | 'radar' | 'category' | null;
const detailKind = ref<DetailKind>(null);
const detailTitle = computed(() => {
  switch (detailKind.value) {
    case 'status':
      return 'Details · Beherrschung nach Status';
    case 'activity':
      return `Details · Aktivität ${formatDayKey(selectedActivityDate.value)}`;
    case 'radar':
      return 'Details · Kompetenz-Radar';
    case 'category':
      return 'Details · Nach Bereich';
    default:
      return '';
  }
});

function openDetail(kind: Exclude<DetailKind, null>): void {
  if (kind === 'status' || kind === 'radar') void loadPartMeta();
  detailKind.value = kind;
}

function closeDetail(): void {
  detailKind.value = null;
}
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
        <div class="prog__section-head">
          <h2 class="prog__section-title">Beherrschung nach Status</h2>
          <button type="button" class="prog__detail-btn" @click="openDetail('status')">Details</button>
        </div>
        <GradingDistribution :counts="progress.gradingCounts" @select="openStatusFilter" />
      </section>
      <section class="prog__section">
        <div class="prog__section-head">
          <h2 class="prog__section-title">Kompetenz-Radar</h2>
          <button type="button" class="prog__detail-btn" @click="openDetail('radar')">Details</button>
        </div>
        <RadarChart :axes="radarAxes" />
      </section>
    </div>

    <section class="prog__section">
      <div class="prog__section-head">
        <h2 class="prog__section-title">Aktivität</h2>
        <button type="button" class="prog__detail-btn" @click="openDetail('activity')">Details</button>
      </div>
      <div class="prog__activity">
        <div class="prog__activity-chart">
          <ActivityHeatmap
            :data="activity"
            :weeks="26"
            :selected-date="selectedActivityDate"
            @select="selectActivityDay"
          />
        </div>
        <div class="prog__activity-panel" aria-live="polite">
          <div class="prog__activity-metrics">
            <div class="prog__activity-metric">
              <span>Zeitraum</span>
              <b>{{ activityTotal }}</b>
              <small>Antworten</small>
            </div>
            <div class="prog__activity-metric">
              <span>Aktive Tage</span>
              <b>{{ activeDayCount }}</b>
              <small>von 182</small>
            </div>
            <div class="prog__activity-metric">
              <span>{{ formatDayKey(selectedActivityDate) }}</span>
              <b>{{ selectedDayEntries.length }}</b>
              <small>{{ selectedDayPoints.awarded }}/{{ selectedDayPoints.max }} P</small>
            </div>
          </div>

          <div class="prog__day-states">
            <div v-for="row in selectedDayRows" :key="row.grading" class="prog__day-state">
              <GradingDot :grading="row.grading" :size="12" />
              <span>{{ row.label }}</span>
              <b>{{ row.count }}</b>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="categoryRows.length > 0" class="prog__section">
      <div class="prog__section-head">
        <h2 class="prog__section-title">Nach Bereich</h2>
        <button type="button" class="prog__detail-btn" @click="openDetail('category')">Details</button>
      </div>
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
      Noch kein Fortschritt — starte dein erstes Programm.
      <RouterLink to="/practice" class="prog__cta">Intelligent üben →</RouterLink>
    </div>

    <Teleport to="body">
      <div v-if="detailKind" class="prog-modal" role="dialog" aria-modal="true" :aria-label="detailTitle" @click.self="closeDetail">
        <div
          class="prog-modal__card"
          :class="{ 'prog-modal__card--wide': detailKind === 'status' || detailKind === 'radar' }"
        >
          <div class="prog-modal__head">
            <h3 class="prog-modal__title">{{ detailTitle }}</h3>
            <button type="button" class="prog-modal__close" aria-label="Schließen" @click="closeDetail">✕</button>
          </div>

          <div v-if="detailKind === 'status'" class="prog-modal__body">
            <div class="prog-modal__chart-grid">
              <section class="prog-modal__chart-card">
                <div class="prog-modal__chart-title">
                  <b>Bewertete Teile</b>
                  <span>{{ gradedPartCount }} Teile mit Status</span>
                </div>
                <GradingDistribution size="large" :counts="progress.gradingCounts" @select="openStatusFilter" />
              </section>
              <section class="prog-modal__chart-card">
                <div class="prog-modal__chart-title">
                  <b>Alle Teile</b>
                  <span>
                    <template v-if="partMetaLoaded">{{ bankPartCount }} Teile inkl. Neu</template>
                    <template v-else>Lade Bankumfang ...</template>
                  </span>
                </div>
                <GradingDistribution
                  size="large"
                  :counts="progress.gradingCounts"
                  :unseen="partMetaLoaded ? allBankUnseenCount : undefined"
                  @select="openStatusFilter"
                />
              </section>
            </div>

            <div class="prog-modal__groups">
              <section v-for="group in statusGroups" :key="group.grading" class="prog-modal__group">
                <div class="prog-modal__group-head">
                  <span><GradingDot :grading="group.grading" :size="12" /> {{ group.label }}</span>
                  <button
                    type="button"
                    class="prog-modal__mini-link"
                    :disabled="group.rows.length === 0"
                    @click="openStatusFilter(group.grading)"
                  >
                    Aufgaben
                  </button>
                </div>
                <div v-if="group.rows.length === 0" class="prog-modal__empty-row">Keine Einträge.</div>
                <div v-else class="prog-modal__list">
                  <div v-for="row in group.rows" :key="row.partId" class="prog-modal__row">
                    <div class="prog-modal__row-main">
                      <div class="prog-modal__row-title">
                        {{ row.title }}<template v-if="row.partLabel"> · {{ row.partLabel }}</template>
                      </div>
                      <div class="prog-modal__row-sub">
                        {{ row.partId }}
                        <template v-if="row.codes.length > 0"> · {{ row.codes.join(', ') }}</template>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div v-else-if="detailKind === 'radar'" class="prog-modal__body">
            <div class="prog-modal__chart-grid">
              <section class="prog-modal__chart-card prog-modal__radar-card">
                <div class="prog-modal__chart-title">
                  <b>Kompetenzen</b>
                  <span>Durchschnitt nach Bereich</span>
                </div>
                <RadarChart :axes="radarAxes" :size="380" />
              </section>
              <section class="prog-modal__chart-card prog-modal__radar-card">
                <div class="prog-modal__chart-title">
                  <b>Beherrschung</b>
                  <span>
                    <template v-if="partMetaLoaded">Statusverteilung inkl. Neu</template>
                    <template v-else>Statusverteilung</template>
                  </span>
                </div>
                <RadarChart :axes="statusRadarAxes" :size="380" />
              </section>
            </div>
          </div>

          <div v-else-if="detailKind === 'activity'" class="prog-modal__body">
            <div v-if="selectedDayEntries.length === 0" class="prog-modal__empty">Keine Antworten an diesem Tag.</div>
            <template v-else>
              <div class="prog-modal__summary-grid">
                <div class="prog-modal__summary-card">
                  <span>Antworten</span>
                  <b>{{ selectedDayEntries.length }}</b>
                </div>
                <div class="prog-modal__summary-card">
                  <span>Punkte</span>
                  <b>{{ selectedDayPoints.awarded }}/{{ selectedDayPoints.max }}</b>
                </div>
                <div class="prog-modal__summary-card">
                  <span>Status</span>
                  <b>{{ selectedDayRows.filter((row) => row.count > 0).length }}</b>
                </div>
              </div>

              <div class="prog-modal__day-state-grid">
                <div v-for="row in selectedDayRows" :key="row.grading" class="prog-modal__day-state">
                  <GradingDot :grading="row.grading" :size="12" />
                  <span>{{ row.label }}</span>
                  <b>{{ row.count }}</b>
                </div>
              </div>

              <div class="prog-modal__timeline">
                <div v-for="entry in selectedDayEntries" :key="`${entry.gradedAt}-${entry.partId}`" class="prog-modal__timeline-row">
                  <time>{{ timeFmt.format(new Date(entry.gradedAt)) }}</time>
                  <GradingDot :grading="entry.grading" :size="13" />
                  <div class="prog-modal__row-main">
                    <div class="prog-modal__row-title">{{ entry.questionId }}</div>
                    <div class="prog-modal__row-sub">
                      {{ entry.partId }} · {{ entry.awardedPoints }}/{{ entry.maxPoints }} P · {{ GRADING_LABELS[entry.grading] }}
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div v-else class="prog-modal__body">
            <div v-if="categoryDetailGroups.length === 0" class="prog-modal__empty">Noch keine Bereichsdaten.</div>
            <div v-else class="prog-modal__category-groups">
              <section v-for="group in categoryDetailGroups" :key="group.code" class="prog-modal__category">
                <div class="prog-modal__category-head">
                  <div>
                    <b>{{ group.code }}</b>
                    <span>{{ group.name }}</span>
                  </div>
                  <button type="button" class="prog-modal__mini-link" @click="openCategory(group.code)">
                    Aufgaben
                  </button>
                </div>
                <div class="prog-modal__competencies">
                  <div v-for="row in group.rows" :key="row.code" class="prog-modal__competency">
                    <span class="prog-modal__competency-code">{{ row.code }}</span>
                    <MasteryBar :code="row.code" :mastery="row.mastery" />
                    <b>{{ row.percent }} %</b>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.prog {
  max-width: 860px;
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
.prog__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.prog__section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin: 0;
}
.prog__detail-btn {
  border: 1px solid var(--q-border-2);
  border-radius: 7px;
  background: var(--q-panel);
  color: var(--q-mut);
  font: 700 11px 'Public Sans', system-ui, sans-serif;
  padding: 5px 9px;
  cursor: pointer;
}
.prog__detail-btn:hover,
.prog__detail-btn:focus-visible {
  border-color: var(--q-accent);
  color: var(--q-accent-strong);
  outline: none;
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
.prog__activity {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.prog__activity-chart {
  padding: 4px 2px 0;
}
.prog__activity-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 0.55fr);
  gap: 12px;
  align-items: stretch;
}
.prog__activity-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.prog__activity-metric {
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-panel);
  padding: 10px 12px;
  min-width: 0;
}
.prog__activity-metric span,
.prog__activity-metric small {
  display: block;
  color: var(--q-faint);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prog__activity-metric b {
  display: block;
  margin: 5px 0 1px;
  font-size: 22px;
  line-height: 1;
  font-weight: 850;
  color: var(--q-ink);
}
.prog__day-states {
  display: grid;
  grid-template-columns: 1fr;
  gap: 5px;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-panel);
  padding: 9px 10px;
}
.prog__day-state {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--q-mut);
}
.prog__day-state b {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--q-ink-2);
}
@media (max-width: 760px) {
  .prog__activity-panel {
    grid-template-columns: 1fr;
  }
  .prog__activity-metrics {
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
.prog-modal {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(0, 0, 0, 0.42);
}
.prog-modal__card {
  width: min(720px, 100%);
  max-height: min(680px, 88vh);
  display: flex;
  flex-direction: column;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  box-shadow: var(--q-shadow-modal);
  overflow: hidden;
}
.prog-modal__card--wide {
  width: min(940px, 100%);
}
.prog-modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--q-border);
}
.prog-modal__title {
  margin: 0;
  font-size: 15px;
  font-weight: 800;
}
.prog-modal__close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: var(--q-panel);
  color: var(--q-mut);
  cursor: pointer;
}
.prog-modal__body {
  padding: 12px 16px 16px;
  overflow-y: auto;
}
.prog-modal__empty {
  color: var(--q-mut-2);
  font-size: 13px;
  padding: 18px 0;
}
.prog-modal__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.prog-modal__status-grid,
.prog-modal__summary-grid,
.prog-modal__day-state-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 14px;
}
.prog-modal__chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.prog-modal__chart-card {
  min-width: 0;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: color-mix(in srgb, var(--q-panel) 72%, transparent);
  padding: 12px;
}
.prog-modal__radar-card {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.prog-modal__chart-title {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 10px;
}
.prog-modal__chart-title b {
  font-size: 13px;
  font-weight: 850;
}
.prog-modal__chart-title span {
  font-size: 11px;
  font-weight: 700;
  color: var(--q-faint);
  text-align: right;
}
.prog-modal__status-card,
.prog-modal__summary-card,
.prog-modal__day-state {
  min-width: 0;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-panel);
  padding: 10px 12px;
}
.prog-modal__status-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.prog-modal__status-card:not(:disabled):hover,
.prog-modal__status-card:focus-visible {
  border-color: var(--q-accent);
  outline: none;
}
.prog-modal__status-card:disabled {
  cursor: default;
  opacity: 0.55;
}
.prog-modal__status-card span,
.prog-modal__day-state span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prog-modal__status-card b,
.prog-modal__day-state b {
  font-variant-numeric: tabular-nums;
}
.prog-modal__groups,
.prog-modal__category-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.prog-modal__group,
.prog-modal__category {
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: color-mix(in srgb, var(--q-panel) 70%, transparent);
  padding: 10px;
}
.prog-modal__group-head,
.prog-modal__category-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.prog-modal__group-head span,
.prog-modal__category-head div {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 800;
}
.prog-modal__category-head div {
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
}
.prog-modal__category-head span {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--q-mut-2);
}
.prog-modal__mini-link {
  flex: none;
  border: 1px solid var(--q-border-2);
  border-radius: 7px;
  background: var(--q-card);
  color: var(--q-accent-strong);
  font: 750 11px 'Public Sans', system-ui, sans-serif;
  padding: 5px 8px;
  cursor: pointer;
}
.prog-modal__mini-link:disabled {
  color: var(--q-disabled);
  cursor: default;
}
.prog-modal__mini-link:not(:disabled):hover,
.prog-modal__mini-link:focus-visible {
  border-color: var(--q-accent);
  outline: none;
}
.prog-modal__empty-row {
  font-size: 12px;
  color: var(--q-faint);
  padding: 6px 2px;
}
.prog-modal__summary-card span {
  display: block;
  font-size: 10.5px;
  color: var(--q-faint);
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.prog-modal__summary-card b {
  display: block;
  margin-top: 4px;
  font-size: 20px;
  line-height: 1;
}
.prog-modal__day-state {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}
.prog-modal__timeline {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.prog-modal__timeline-row {
  display: grid;
  grid-template-columns: 44px auto minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
}
.prog-modal__timeline-row time {
  font: 750 11px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
}
.prog-modal__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
}
.prog-modal__row-main {
  min-width: 0;
  flex: 1;
}
.prog-modal__row-title {
  font-size: 13px;
  font-weight: 750;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prog-modal__row-sub {
  font-size: 11.5px;
  color: var(--q-mut-2);
  margin-top: 2px;
}
.prog-modal__competencies {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.prog-modal__competency {
  display: grid;
  grid-template-columns: 68px minmax(140px, 1fr) 48px;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  background: var(--q-card);
}
.prog-modal__competency-code {
  font: 800 11px ui-monospace, Menlo, monospace;
  color: var(--q-accent-strong);
}
.prog-modal__competency b {
  text-align: right;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 560px) {
  .prog-modal__competency {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .prog-modal__timeline-row {
    grid-template-columns: 40px minmax(0, 1fr);
  }
  .prog-modal__timeline-row .q-grading-dot {
    display: none;
  }
}
</style>
