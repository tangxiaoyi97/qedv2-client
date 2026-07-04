<script setup lang="ts">
/**
 * Verlauf (user feedback #4 + history upgrade doc §1):
 *
 *  - logged in → cloud history via GET /me/history (paginated, newest first);
 *    question titles are joined client-side from the question cache / core
 *    batch endpoint (the server returns identifiers only, contract §8.3);
 *  - guest → local HistoryLog (this device only, labeled as such);
 *  - v1 does NOT backfill guest history into the cloud on login — the two
 *    accumulate independently (upgrade doc §1.1).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { NetworkError, type Verdict } from '@qed2/core-logic';
import { ActivityHeatmap, GradingDot, QButton, StateIcon } from '@qed2/ui';
import { historyLog, questionCache } from '../services.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';

const router = useRouter();
const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();

const PAGE_SIZE = 50;

interface Row {
  key: string;
  partId: string;
  questionId: string;
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number | undefined;
  gradedAt: string;
  elapsedMs: number | undefined;
}

const rows = ref<Row[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref<string | undefined>();
const titles = ref<Map<string, string>>(new Map());

const cloudMode = computed(() => auth.isLoggedIn);

function verdictOf(correct: boolean, awarded: number): Verdict {
  return correct ? 'correct' : awarded > 0 ? 'partial' : 'incorrect';
}

/** Join titles from the local question cache; fetch missing ones from core. */
async function joinTitles(questionIds: string[]): Promise<void> {
  const unique = [...new Set(questionIds)].filter((id) => !titles.value.has(id));
  if (unique.length === 0) return;
  const missing: string[] = [];
  const next = new Map(titles.value);
  for (const id of unique) {
    const cached = await questionCache.get(id);
    if (cached) next.set(id, cached.title);
    else missing.push(id);
  }
  if (missing.length > 0) {
    try {
      const res = await app.coreClient.getQuestionsBatch(missing);
      for (const q of res.questions) next.set(q.id, q.title);
      await questionCache.putMany(res.questions);
    } catch {
      // titles stay blank — rows still render with ids (core may be offline)
    }
  }
  titles.value = next;
}

async function loadPage(reset: boolean): Promise<void> {
  loading.value = true;
  error.value = undefined;
  const target = reset ? 1 : page.value + 1;
  try {
    let batch: Row[] = [];
    if (cloudMode.value) {
      const res = await app.serverClient.getHistory({ page: target, pageSize: PAGE_SIZE });
      total.value = res.total;
      batch = res.items.map((i) => ({
        key: i.id,
        partId: i.partId,
        questionId: i.questionId,
        verdict: verdictOf(i.correct, i.awardedPoints),
        awardedPoints: i.awardedPoints,
        maxPoints: undefined, // audit rows carry no maxPoints — omit the denominator
        gradedAt: i.gradedAt,
        elapsedMs: i.elapsedMs ?? undefined,
      }));
    } else {
      const list = await historyLog.list(PAGE_SIZE, (target - 1) * PAGE_SIZE);
      total.value = await historyLog.count();
      batch = list.map((e) => ({
        key: `${e.gradedAt}-${e.partId}`,
        partId: e.partId,
        questionId: e.questionId,
        verdict: e.verdict,
        awardedPoints: e.awardedPoints,
        maxPoints: e.maxPoints,
        gradedAt: e.gradedAt,
        elapsedMs: e.elapsedMs,
      }));
    }
    rows.value = reset ? batch : [...rows.value, ...batch];
    page.value = target;
    void joinTitles(batch.map((r) => r.questionId));
  } catch (e) {
    error.value =
      e instanceof NetworkError
        ? 'Server nicht erreichbar — Verlauf ist gerade nicht verfügbar.'
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void loadPage(true));
// login/logout switches the source — reload from page 1, never mixing the two
watch(cloudMode, () => void loadPage(true));
// new answers land in the local log (and in /me/attempts at session end)
watch(
  () => progress.historyVersion,
  () => {
    if (!cloudMode.value) void loadPage(true);
  },
);

/* heatmap: local activity is the honest per-device signal for both modes;
   for cloud mode it still reflects what was practiced ON THIS DEVICE. */
const activity = ref<Record<string, number>>({});
watch(
  () => progress.historyVersion,
  async () => {
    activity.value = await historyLog.dailyActivity(182, new Date());
  },
  { immediate: true },
);

/* group rows by local day for display */
const dayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });

const groups = computed(() => {
  const byDay = new Map<string, { label: string; rows: Row[] }>();
  for (const r of rows.value) {
    const d = new Date(r.gradedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = byDay.get(key);
    if (!g) {
      g = { label: dayFmt.format(d), rows: [] };
      byDay.set(key, g);
    }
    g.rows.push(r);
  }
  return [...byDay.values()];
});

const hasMore = computed(() => rows.value.length < total.value);

function fmtPoints(r: Row): string {
  const a = r.awardedPoints.toLocaleString('de-AT');
  return r.maxPoints !== undefined ? `${a}/${r.maxPoints.toLocaleString('de-AT')} P` : `${a} P`;
}

function redo(questionId: string): void {
  const questionIds = [...new Set(rows.value.map((r) => r.questionId))];
  void router.push({
    path: '/practice',
    query: {
      source: 'history',
      questions: questionIds.join(','),
      focus: questionId,
      returnTo: router.currentRoute.value.fullPath,
    },
  });
}
</script>

<template>
  <div class="hist">
    <div class="hist__head">
      <h1 class="hist__title">Verlauf</h1>
      <span v-if="total > 0" class="hist__count">{{ total }} Antworten</span>
    </div>
    <p class="hist__note">
      <template v-if="cloudMode">Verlauf aus deinem Konto (alle Geräte, ab Anmeldung).</template>
      <template v-else>Verlauf wird lokal auf diesem Gerät gespeichert.</template>
    </p>

    <section class="hist__section">
      <h2 class="hist__section-title">Aktivität</h2>
      <ActivityHeatmap :data="activity" :weeks="52" />
    </section>

    <div v-if="error" class="hist__error">
      {{ error }}
      <QButton variant="secondary" @click="loadPage(true)">Erneut versuchen</QButton>
    </div>

    <div v-else-if="loading && rows.length === 0" class="hist__list">
      <div v-for="i in 6" :key="i" class="hist__skeleton" />
    </div>

    <div v-else-if="rows.length === 0" class="hist__empty">
      Noch keine Antworten aufgezeichnet.
      <RouterLink to="/practice" class="hist__cta">Intelligent üben →</RouterLink>
    </div>

    <template v-else>
      <section v-for="group in groups" :key="group.label" class="hist__day">
        <h3 class="hist__day-label">{{ group.label }}</h3>
        <div class="hist__list">
          <button
            v-for="r in group.rows"
            :key="r.key"
            type="button"
            class="hist__row"
            :title="`${r.questionId} erneut üben`"
            @click="redo(r.questionId)"
          >
            <StateIcon :state="r.verdict === 'correct' ? 'correct' : r.verdict === 'partial' ? 'partial' : 'incorrect'" :size="18" />
            <span class="hist__row-title">{{ titles.get(r.questionId) ?? r.questionId }}</span>
            <span class="hist__row-part">{{ r.partId }}</span>
            <GradingDot
              :grading="progress.partState.get(r.partId)?.grading ?? 'unseen'"
              :size="13"
              title="Aktueller Status"
            />
            <span class="hist__row-points">{{ fmtPoints(r) }}</span>
            <span class="hist__row-time">{{ timeFmt.format(new Date(r.gradedAt)) }}</span>
          </button>
        </div>
      </section>

      <div v-if="hasMore" class="hist__more">
        <QButton variant="secondary" :disabled="loading" @click="loadPage(false)">
          {{ loading ? 'Lade …' : 'Mehr laden' }}
        </QButton>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hist {
  max-width: 720px;
  margin: 0 auto;
  padding: 26px 20px 40px;
}
.hist__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.hist__title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0;
}
.hist__count {
  font-size: 12.5px;
  color: var(--q-mut-2);
}
.hist__note {
  font-size: 11.5px;
  color: var(--q-faint);
  margin: 6px 0 16px;
}
.hist__section {
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 18px;
}
.hist__section-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin: 0 0 12px;
}
.hist__day {
  margin-bottom: 14px;
}
.hist__day-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-mut);
  margin: 0 0 7px 2px;
}
.hist__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hist__row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 13px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 10px;
  cursor: pointer;
  font: inherit;
  color: var(--q-ink);
  text-align: left;
  width: 100%;
  transition: all var(--q-transition-fast);
}
@media (hover: hover) and (pointer: fine) {
  .hist__row:hover {
    border-color: var(--q-accent);
    background: linear-gradient(135deg, var(--q-card), var(--q-panel-2));
    transform: translateY(-1px);
    box-shadow: var(--q-shadow-card);
  }
}
.hist__row:active {
  background: var(--q-panel-2);
  transform: scale(0.99);
}
.hist__row:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.hist__row-title {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist__row-part {
  font: 500 10.5px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  flex: none;
}
.hist__row-points {
  font: 700 12px ui-monospace, Menlo, monospace;
  color: var(--q-mut);
  flex: none;
  font-variant-numeric: tabular-nums;
}
.hist__row-time {
  font-size: 11px;
  color: var(--q-faint);
  flex: none;
  width: 38px;
  text-align: right;
}
.hist__skeleton {
  height: 42px;
  border-radius: 10px;
  background: var(--q-panel);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.5;
  }
}
.hist__error,
.hist__empty {
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
.hist__cta {
  font-weight: 700;
  color: var(--q-accent-strong);
  text-decoration: none;
}
.hist__more {
  display: flex;
  justify-content: center;
  padding: 14px 0;
}
@media (max-width: 640px) {
  .hist__row-part {
    display: none;
  }
}
</style>
