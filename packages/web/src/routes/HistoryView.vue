<script setup lang="ts">
/**
 * Verlauf (user feedback #4 + history upgrade doc §1):
 *
 *  - logged in → cloud history via GET /me/history (paginated, newest first);
 *    question titles are joined client-side from the question cache / core
 *    batch endpoint (the server returns identifiers only, contract §8.3);
 *  - guest → local HistoryLog (this device only, labeled as such);
 *  - invite redemption claims the durable guest-attempt outbox for the new
 *    account; ordinary login does not, which protects shared devices.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  CoreClient,
  NetworkError,
  VERDICT_LABELS,
  formatScore,
  localActivityRange,
  localDayRange,
  parseLocalDayKey,
  questionContentHash,
  type CoreSourcePreference,
  type Verdict,
} from '@qed2/core-logic';
import { ActivityHeatmap, QButton, QSkeleton, StateIcon } from '@qed2/ui';
import { historyLog, ports, questionCache } from '../services.js';
import { useAppStore } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';
import { shortCommit } from '../version-info.js';

const router = useRouter();
const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();

const PAGE_SIZE = 50;
const ACTIVITY_WEEKS = 52;
const ACTIVITY_DAYS = ACTIVITY_WEEKS * 7;
interface Row {
  key: string;
  partId: string;
  questionId: string;
  verdict: Verdict;
  awardedPoints: number;
  maxPoints: number | undefined;
  gradedAt: string;
  elapsedMs: number | undefined;
  contentSource?: CoreSourcePreference;
  contentId?: string;
  /** Cloud rows created before provenance support cannot be replayed exactly. */
  provenanceUnknown: boolean;
}

const rows = ref<Row[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref<string | undefined>();
const titles = ref<Map<string, string>>(new Map());
const selectedDate = ref<string | null>(null);
let loadRequest = 0;
let activityRequest = 0;

const cloudMode = computed(() => auth.isLoggedIn);

/** Disambiguates duplicate local rows (see key construction below). */
let rowSeq = 0;

function verdictOf(correct: boolean, awarded: number): Verdict {
  return correct ? 'correct' : awarded > 0 ? 'partial' : 'incorrect';
}

/** Join titles from the local question cache; fetch missing ones from core. */
function titleKey(row: Pick<Row, 'questionId' | 'contentSource' | 'contentId'>): string {
  return `${row.contentSource ?? 'current'}:${row.contentId ?? 'current'}:${row.questionId}`;
}

function hasExactProvenance(
  row: Pick<Row, 'contentSource' | 'contentId'>,
): row is { contentSource: CoreSourcePreference; contentId: string } {
  return (row.contentSource === 'local' || row.contentSource === 'remote')
    && typeof row.contentId === 'string'
    && /^[0-9a-f]{40}$/u.test(row.contentId);
}

async function joinTitles(sourceRows: Row[]): Promise<void> {
  const unique = [...new Map(sourceRows.map((row) => [titleKey(row), row])).values()]
    .filter((row) => !titles.value.has(titleKey(row)));
  if (unique.length === 0) return;
  const missingRevisions = new Map<string, {
    source: CoreSourcePreference;
    contentId: string;
    rows: Row[];
  }>();
  const next = new Map(titles.value);
  for (const row of unique) {
    // A legacy row without provenance is not a claim about today's bank.
    // Keep its stable question id visible, but do not borrow a cached/current
    // title or contact Core until the user explicitly chooses to redo it.
    if (!hasExactProvenance(row)) continue;
    const cached = await questionCache.getVerified(row.questionId, row.contentId);
    if (cached) next.set(titleKey(row), cached.title);
    else {
      const key = `${row.contentSource}:${row.contentId}`;
      const group = missingRevisions.get(key) ?? {
        source: row.contentSource,
        contentId: row.contentId,
        rows: [],
      };
      group.rows.push(row);
      missingRevisions.set(key, group);
    }
  }
  for (const group of missingRevisions.values()) {
    try {
      const endpoint = await ports.coreRuntime.getEndpoint(group.source);
      const client = new CoreClient(endpoint.baseUrl);
      const manifest = await client.revisionManifest(group.contentId);
      if (manifest.commit !== group.contentId) throw new Error('revision manifest mismatch');
      const ids = [...new Set(group.rows.map((row) => row.questionId))];
      const response = await client.getRevisionQuestionsBatch(group.contentId, ids);
      const requested = new Set(ids);
      const verified: typeof response.questions = [];
      for (const entry of response.questions) {
        if (
          !requested.has(entry.question.id)
          || manifest.items[entry.question.id] !== entry.contentHash
          || questionContentHash(entry.question) !== entry.wireHash
        ) {
          throw new Error('historical question integrity mismatch');
        }
        verified.push(entry);
      }
      await questionCache.putManyVerified(verified, group.contentId);
      for (const entry of verified) {
        for (const row of group.rows) {
          if (row.questionId === entry.question.id) {
            next.set(titleKey(row), entry.question.title);
          }
        }
      }
    } catch {
      // Exact historical content remains unavailable; never borrow a title
      // from the current bank merely because the question id still exists.
    }
  }
  titles.value = next;
}

async function loadPage(reset: boolean): Promise<void> {
  const request = ++loadRequest;
  const sourceUserId = auth.session?.user.id;
  const isCurrentRequest = () =>
    request === loadRequest && auth.session?.user.id === sourceUserId;
  if (reset) {
    rows.value = [];
    total.value = 0;
    page.value = 1;
  }
  loading.value = true;
  error.value = undefined;
  const target = reset ? 1 : page.value + 1;
  try {
    let batch: Row[] = [];
    if (cloudMode.value) {
      const range = selectedDate.value ? localDayRange(selectedDate.value) : {};
      const res = await app.serverClient.getHistory({
        page: target,
        pageSize: PAGE_SIZE,
        ...range,
      });
      if (!isCurrentRequest()) return;
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
        contentSource: i.contentSource,
        contentId: i.contentId,
        provenanceUnknown: !hasExactProvenance(i),
      }));
    } else {
      const offset = (target - 1) * PAGE_SIZE;
      const allForDay = selectedDate.value
        ? await historyLog.listByLocalDay(selectedDate.value)
        : undefined;
      const list = allForDay
        ? allForDay.slice(offset, offset + PAGE_SIZE)
        : await historyLog.list(PAGE_SIZE, offset);
      if (!isCurrentRequest()) return;
      total.value = allForDay?.length ?? await historyLog.count();
      batch = list.map((e) => ({
        // gradedAt+partId alone can collide (same part graded twice within
        // one second) — disambiguate with a load-local sequence number.
        key: `${e.gradedAt}-${e.partId}-${rowSeq++}`,
        partId: e.partId,
        questionId: e.questionId,
        verdict: e.verdict,
        awardedPoints: e.awardedPoints,
        maxPoints: e.maxPoints,
        gradedAt: e.gradedAt,
        elapsedMs: e.elapsedMs,
        contentSource: e.contentSource,
        contentId: e.contentId,
        provenanceUnknown: !hasExactProvenance(e),
      }));
    }
    if (!isCurrentRequest()) return;
    rows.value = reset ? batch : [...rows.value, ...batch];
    page.value = target;
    void joinTitles(batch);
  } catch (e) {
    if (!isCurrentRequest()) return;
    error.value =
      e instanceof NetworkError
        ? 'Server nicht erreichbar — Verlauf ist gerade nicht verfügbar.'
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    if (isCurrentRequest()) loading.value = false;
  }
}

onMounted(() => void loadPage(true));
// Login/logout and direct account replacement switch the source. Reload from
// page 1 and invalidate in-flight reads so rows from two accounts never mix.
watch(() => auth.session?.user.id, () => {
  selectedDate.value = null;
  activity.value = {};
  void loadPage(true);
  void loadActivity();
});
// new answers land in the local log (and in /me/attempts at session end)
watch(
  () => [progress.historyVersion, progress.cloudHistoryVersion] as const,
  () => {
    void loadPage(true);
    void loadActivity();
  },
);

/* Heatmap and list now use the same authority. Previously the account list
   showed all devices while the heatmap silently counted only this device —
   both internally consistent datasets, but an incorrect screen. */
const activity = ref<Record<string, number>>({});
const activityLoading = ref(false);
const activityError = ref<string | undefined>();
const attemptHistoryMessage = computed(() =>
  cloudMode.value && progress.attemptUploadStatus.state !== 'idle'
    ? progress.attemptUploadStatus.message ?? 'Der Cloud-Verlauf ist noch nicht vollständig.'
    : undefined,
);

async function retryPendingHistory(): Promise<void> {
  await progress.flushAttemptOutbox();
  await Promise.all([loadPage(true), loadActivity()]);
}

async function loadActivity(): Promise<void> {
  const request = ++activityRequest;
  const sourceUserId = auth.session?.user.id;
  const isCurrentRequest = () =>
    request === activityRequest && auth.session?.user.id === sourceUserId;
  activityLoading.value = true;
  activityError.value = undefined;
  try {
    if (!cloudMode.value) {
      const local = await historyLog.dailyActivity(ACTIVITY_DAYS, new Date());
      if (isCurrentRequest()) activity.value = local;
      return;
    }

    const range = localActivityRange(ACTIVITY_DAYS, new Date());
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const res = await app.serverClient.getHistoryActivity({ ...range, timeZone });
    if (!isCurrentRequest()) return;
    activity.value = res.activity;
  } catch {
    if (!isCurrentRequest()) return;
    activity.value = {};
    activityError.value = 'Aktivität konnte nicht geladen werden.';
  } finally {
    if (isCurrentRequest()) activityLoading.value = false;
  }
}

onMounted(() => void loadActivity());

/* group rows by local day for display */
const dayFmt = new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' });
const selectedDayFmt = new Intl.DateTimeFormat('de-AT', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const selectedDateLabel = computed(() =>
  selectedDate.value ? selectedDayFmt.format(parseLocalDayKey(selectedDate.value)) : '',
);

function selectDate(dayKey: string): void {
  selectedDate.value = selectedDate.value === dayKey ? null : dayKey;
  void loadPage(true);
}

function clearDateFilter(): void {
  if (!selectedDate.value) return;
  selectedDate.value = null;
  void loadPage(true);
}

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
  const a = formatScore(r.awardedPoints);
  return r.maxPoints !== undefined ? `${a}/${formatScore(r.maxPoints)} P` : `${a} P`;
}

function redo(row: Row): void {
  const exactProvenance = hasExactProvenance(row)
    ? { coreSource: row.contentSource, contentId: row.contentId }
    : {};
  void router.push({
    path: '/practice',
    query: {
      source: 'history',
      questions: row.questionId,
      focus: row.questionId,
      ...exactProvenance,
      returnTo: router.currentRoute.value.fullPath,
    },
  });
}
</script>

<template>
  <div class="hist q-page">
    <div class="hist__head">
      <h1 class="hist__title q-page-title">Verlauf</h1>
      <span v-if="total > 0" class="hist__count">
        {{ total }} {{ total === 1 ? 'Antwort' : 'Antworten' }}
      </span>
    </div>
    <p class="hist__note">
      <template v-if="cloudMode">Verlauf aus deinem Konto (alle Geräte, ab Anmeldung).</template>
      <template v-else>Verlauf wird lokal auf diesem Gerät gespeichert.</template>
    </p>

    <section class="hist__section">
      <div class="hist__section-head">
        <h2 class="hist__section-title">Aktivität</h2>
        <button
          v-if="selectedDate"
          type="button"
          class="hist__filter-clear"
          @click="clearDateFilter"
        >
          Alle Tage
        </button>
      </div>
      <ActivityHeatmap
        v-if="!activityLoading && !activityError && !attemptHistoryMessage"
        :data="activity"
        :weeks="ACTIVITY_WEEKS"
        :selected-date="selectedDate"
        @select="selectDate"
      />
      <p v-if="activityLoading" class="hist__heatmap-note" role="status">Aktivität wird geladen …</p>
      <p v-else-if="activityError" class="hist__heatmap-note hist__heatmap-note--error" role="alert">
        {{ activityError }}
      </p>
      <div
        v-else-if="attemptHistoryMessage"
        class="hist__heatmap-note hist__heatmap-note--error"
        :role="progress.attemptUploadStatus.state === 'error' ? 'alert' : 'status'"
      >
        {{ attemptHistoryMessage }}
        <QButton
          v-if="progress.attemptUploadStatus.state !== 'uploading'"
          variant="secondary"
          @click="retryPendingHistory"
        >
          Erneut versuchen
        </QButton>
      </div>
      <p v-if="selectedDate" class="hist__filter-status" role="status">
        Verlauf gefiltert: {{ selectedDateLabel }}
      </p>
    </section>

    <div class="hist__stage q-crossfade">
    <transition name="q-crossfade">
    <div v-if="error && rows.length === 0" key="error" class="hist__error">
      {{ error }}
      <QButton variant="secondary" @click="loadPage(true)">Erneut versuchen</QButton>
    </div>

    <QSkeleton
      v-else-if="loading && rows.length === 0"
      key="loading"
      :rows="6"
      height="42px"
      label="Verlauf wird geladen …"
    />

    <div v-else-if="rows.length === 0" key="empty" class="hist__empty">
      <template v-if="selectedDate">
        Keine Antworten an diesem Tag.
        <QButton variant="secondary" @click="clearDateFilter">Alle Tage anzeigen</QButton>
      </template>
      <template v-else>
        Noch keine Antworten aufgezeichnet.
        <RouterLink to="/practice" class="hist__cta">Programm starten →</RouterLink>
      </template>
    </div>

    <div v-else key="list" class="hist__groups">
      <section v-for="group in groups" :key="group.label" class="hist__day">
        <h3 class="hist__day-label">{{ group.label }}</h3>
        <div class="hist__list">
          <button
            v-for="r in group.rows"
            :key="r.key"
            type="button"
            class="hist__row"
            :title="r.provenanceUnknown
              ? `${r.questionId} mit der aktuellen Aufgabenbank erneut üben; Quellversion unbekannt`
              : `${r.questionId} erneut üben`"
            @click="redo(r)"
          >
            <StateIcon
              :state="r.verdict === 'correct' ? 'correct' : r.verdict === 'partial' ? 'partial' : 'incorrect'"
              :size="18"
              :label="VERDICT_LABELS[r.verdict]"
            />
            <span class="hist__row-copy">
              <span class="hist__row-title">{{ titles.get(titleKey(r)) ?? r.questionId }}</span>
              <span v-if="r.provenanceUnknown" class="hist__row-provenance">
                Quellversion unbekannt · Wiederholung mit aktueller Bank
              </span>
              <span
                v-else-if="r.contentSource && r.contentId"
                class="hist__row-source"
                :title="`Bank ${r.contentId}`"
              >
                {{ r.contentSource === 'local' ? 'Lokal' : 'Remote' }} · {{ shortCommit(r.contentId) }}
              </span>
            </span>
            <span class="hist__row-part">{{ r.partId }}</span>
            <span class="hist__row-points">{{ fmtPoints(r) }}</span>
            <span class="hist__row-time">{{ timeFmt.format(new Date(r.gradedAt)) }}</span>
          </button>
        </div>
      </section>

      <div v-if="hasMore" class="hist__more">
        <p v-if="error" class="hist__more-error" role="alert">{{ error }}</p>
        <QButton variant="secondary" :disabled="loading" @click="loadPage(false)">
          {{ loading ? 'Lade …' : error ? 'Erneut versuchen' : 'Mehr laden' }}
        </QButton>
      </div>
    </div>
    </transition>
    </div>
  </div>
</template>

<style scoped>
.hist {
  max-width: 720px;
}
.hist__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
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
.hist__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.hist__filter-clear {
  margin: 0 0 12px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--q-accent-strong);
  cursor: pointer;
  font: 700 10.5px 'Public Sans', system-ui, sans-serif;
}
.hist__filter-clear:hover {
  color: var(--q-ink);
}
.hist__filter-clear:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 3px;
}
.hist__filter-status {
  margin: 10px 0 0;
  color: var(--q-mut);
  font-size: 11px;
  font-weight: 650;
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
.hist__row-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hist__row-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hist__row-provenance {
  color: var(--q-mut-2);
  font-size: 9.5px;
  font-weight: 650;
  line-height: 1.25;
}
.hist__row-source {
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  padding: 2px 6px;
  border: 1px solid var(--q-border-soft);
  border-radius: 999px;
  background: var(--q-panel-2);
  color: var(--q-mut-2);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 1.25;
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
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 0;
}
.hist__more-error {
  margin: 0;
  font-size: 12px;
  color: var(--q-err-ink);
}
.hist__heatmap-note {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--q-faint);
}
.hist__heatmap-note--error {
  color: var(--q-err-ink);
}
@media (max-width: 640px) {
  .hist__row-part {
    display: none;
  }
}
</style>
