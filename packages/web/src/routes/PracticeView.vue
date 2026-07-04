<script setup lang="ts">
/**
 * Practice flow, redesigned (user feedback #2/#3 + tsx layout reference):
 *
 *  - the question meta lives IN the content as a big title header (no banner)
 *    together with the ever-present grading menu + star (supplement §2/§3);
 *  - feedback (ResultPill), the Lösung toggle and the primary action sit in a
 *    STICKY BOTTOM BAR; the official solution expands UPWARD from it
 *    (SolutionSheet, collapsed by default, auto-opened for self-assessment);
 *  - PartPlayer runs chromeless: it reports state, the bar triggers it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type {
  GradeResult,
  Grading,
  QuestionsFilter,
  Submission,
  QuestionPart,
  Term,
  ExamPart,
} from '@qed2/core-logic';
import {
  GradingMenu,
  PartPlayer,
  QButton,
  QChip,
  ResultPill,
  RichTextView,
  SolutionSheet,
  StarButton,
  StateIcon,
  type PartPlayerState,
} from '@qed2/ui';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import { useAuthStore } from '../stores/auth.js';

const route = useRoute();
const router = useRouter();
const practice = usePracticeStore();
const progress = useProgressStore();
const auth = useAuthStore();

const TERM_LABELS: Record<Term, string> = {
  haupttermin: 'Haupttermin',
  'nebentermin-1': 'Nebentermin 1',
  'nebentermin-2': 'Nebentermin 2',
  herbsttermin: 'Herbsttermin',
  wintertermin: 'Wintertermin',
};

const current = computed(() => practice.current);
const progressPct = computed(() =>
  practice.total === 0 ? 0 : Math.round((practice.index / practice.total) * 100),
);

/* --- PartPlayer shell contract --- */
const playerRef = ref<InstanceType<typeof PartPlayer> | null>(null);
const playerState = ref<PartPlayerState>({
  phase: 'answering',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
});
const solutionOpen = ref(false);

function onPlayerState(state: PartPlayerState): void {
  const wasSelfAssessing = playerState.value.phase === 'self-assessing';
  playerState.value = state;
  // Comparing against the official solution is the whole point of
  // self-assessment — open the sheet for the user.
  if (state.phase === 'self-assessing' && !wasSelfAssessing) solutionOpen.value = true;
}

async function onGraded(payload: {
  partId: string;
  result: GradeResult;
  submission: Submission;
  selfAssessed: boolean;
}): Promise<void> {
  const part: QuestionPart | undefined = current.value?.part;
  if (!part || part.id !== payload.partId) return;
  await practice.recordGraded({ part, result: payload.result, submission: payload.submission });
}

function primaryAction(): void {
  switch (playerState.value.phase) {
    case 'answering':
      playerRef.value?.submit();
      break;
    case 'self-assessing':
      playerRef.value?.confirmSelfAssessment();
      break;
    case 'reviewed':
      practice.next();
      break;
  }
}

const primaryLabel = computed(() => {
  switch (playerState.value.phase) {
    case 'answering':
      return 'Prüfen';
    case 'self-assessing':
      return 'Bewertung übernehmen';
    case 'reviewed':
      return 'Weiter →';
  }
  return '';
});

const primaryDisabled = computed(
  () => playerState.value.phase === 'answering' && !playerState.value.canSubmit,
);

/* --- grading menu + star (ever-present, supplement §1.2/§2) --- */
const currentGrading = computed(
  () => progress.partState.get(current.value?.part.id ?? '')?.grading ?? 'unseen',
);
const currentStarred = computed(
  () => progress.partState.get(current.value?.part.id ?? '')?.starred ?? false,
);

async function onGradingSelect(grading: Grading): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId) return;
  await practice.overrideGrading(partId, grading);
}

async function onStarToggle(): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId) return;
  await progress.setStarred(partId, !currentStarred.value);
}

/* --- session lifecycle --- */
function start(): void {
  const q = route.query;
  if (typeof q.questions === 'string' && q.questions.length > 0) {
    void practice.startQuestions(q.questions.split(',').filter(Boolean));
    return;
  }
  const filters: QuestionsFilter = {};
  if (typeof q.year === 'string' && q.year) filters.year = Number(q.year);
  if (typeof q.term === 'string' && q.term) filters.term = q.term as Term;
  if (typeof q.part === 'string' && q.part) filters.part = q.part as ExamPart;
  if (typeof q.gk === 'string' && q.gk) filters.gk = q.gk;
  const opts: Parameters<typeof practice.startSmart>[0] =
    Object.keys(filters).length > 0 ? { filters } : {};
  void practice.startSmart(opts);
}

onMounted(() => {
  const hasQuery = typeof route.query.questions === 'string' || typeof route.query.year === 'string'
    || typeof route.query.term === 'string' || typeof route.query.part === 'string' || typeof route.query.gk === 'string';
  // Explicit deep links always (re)start; otherwise respect a session the
  // browse page already seeded in the store (loading/running handoff).
  if (hasQuery || (practice.phase !== 'running' && practice.phase !== 'loading')) start();
});

watch(
  () => practice.index,
  () => {
    solutionOpen.value = false;
    window.scrollTo({ top: 0 });
  },
);

function exit(): void {
  if (practice.phase === 'running' && practice.graded.length < practice.total) {
    if (!window.confirm('Sitzung beenden? Dein Fortschritt bleibt gespeichert.')) return;
  }
  practice.abort();
  void router.push('/');
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowRight' && playerState.value.phase === 'reviewed' && practice.phase === 'running') {
    ev.preventDefault();
    practice.next();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const multiPart = computed(() => (current.value?.question.parts.length ?? 0) > 1);
const summaryStats = computed(() => practice.summary);

/* --- session rail (left sidebar): the session's items + current position --- */
interface RailItem {
  index: number;
  partId: string;
  title: string;
  partLabel: string | undefined;
  state: 'correct' | 'partial' | 'incorrect' | 'current' | 'pending';
  jumpable: boolean;
}

const railItems = computed<RailItem[]>(() => {
  const verdictByPart = new Map(practice.graded.map((g) => [g.partId, g.result.verdict]));
  return practice.items.map((item, i) => {
    const q = practice.questions.get(item.questionId);
    const qMulti = (q?.parts.length ?? 0) > 1;
    const part = q?.parts.find((p) => p.id === item.partId);
    const verdict = verdictByPart.get(item.partId);
    return {
      index: i,
      partId: item.partId,
      title: q?.title ?? item.questionId,
      partLabel: qMulti ? part?.label : undefined,
      state: verdict ?? (i === practice.index ? 'current' : 'pending'),
      jumpable: verdict === undefined && i !== practice.index,
    };
  });
});

const gradedCount = computed(() => practice.graded.length);
const sourceLine = computed(() => {
  const q = current.value?.question;
  if (!q) return '';
  return `${TERM_LABELS[q.source.term]} ${q.source.year} · ${q.source.part === 't1' ? 'Teil 1' : 'Teil 2'}`;
});
</script>

<template>
  <div class="practice q-app">
    <!-- top bar -->
    <div class="practice__topbar">
      <button type="button" class="practice__close" aria-label="Sitzung beenden" @click="exit">✕</button>
      <div class="practice__progress">
        <div class="practice__progress-label">
          <template v-if="practice.phase === 'running'">Aufgabe {{ practice.index + 1 }} von {{ practice.total }}</template>
          <template v-else-if="practice.phase === 'summary'">Sitzung abgeschlossen</template>
          <template v-else>QED<span class="practice__logo-accent">2</span></template>
        </div>
        <div class="practice__progress-track">
          <div class="practice__progress-fill" :style="{ width: `${practice.phase === 'summary' ? 100 : progressPct}%` }" />
        </div>
      </div>
      <span class="practice__spacer" />
    </div>

    <!-- loading -->
    <div v-if="practice.phase === 'loading'" class="practice__center">
      <div class="practice__skeleton">
        <div class="practice__skeleton-bar" style="width: 40%" />
        <div class="practice__skeleton-bar" style="width: 90%" />
        <div class="practice__skeleton-bar" style="width: 75%" />
        <div class="practice__skeleton-bar" style="width: 85%" />
      </div>
      <div class="practice__loading-text">Aufgaben werden geladen …</div>
    </div>

    <!-- error -->
    <div v-else-if="practice.phase === 'error'" class="practice__center">
      <div class="practice__error">
        <div class="practice__error-title">Aufgaben konnten nicht geladen werden</div>
        <div class="practice__error-text">
          {{ practice.error }} — ist der Inhalts-Server erreichbar? (Einstellungen → Serveradressen)
        </div>
        <div class="practice__actions-row">
          <QButton variant="secondary" @click="exit">Zurück</QButton>
          <QButton @click="start">Erneut versuchen</QButton>
        </div>
      </div>
    </div>

    <!-- summary -->
    <div v-else-if="practice.phase === 'summary'" class="practice__center">
      <div class="practice__summary">
        <h2 class="practice__summary-title">Sitzung abgeschlossen</h2>
        <div v-if="summaryStats.count === 0" class="practice__error-text">
          Keine passenden Aufgaben gefunden — andere Filter probieren?
        </div>
        <template v-else>
          <div class="practice__summary-grid">
            <div class="practice__stat">
              <div class="practice__stat-num">{{ summaryStats.count }}</div>
              <div class="practice__stat-label">Aufgaben</div>
            </div>
            <div class="practice__stat">
              <div class="practice__stat-num">
                {{ summaryStats.points.toLocaleString('de-AT') }}<span class="practice__stat-sub">/{{ summaryStats.maxPoints.toLocaleString('de-AT') }}</span>
              </div>
              <div class="practice__stat-label">Punkte</div>
            </div>
            <div class="practice__stat practice__stat--verdicts">
              <span class="practice__verdict"><StateIcon state="correct" :size="16" /> {{ summaryStats.byVerdict.correct }}</span>
              <span class="practice__verdict"><StateIcon state="partial" :size="16" /> {{ summaryStats.byVerdict.partial }}</span>
              <span class="practice__verdict"><StateIcon state="incorrect" :size="16" /> {{ summaryStats.byVerdict.incorrect }}</span>
            </div>
          </div>
          <div v-if="summaryStats.competencies.length > 0" class="practice__summary-comps">
            <QChip v-for="c in summaryStats.competencies" :key="c">{{ c }}</QChip>
          </div>
          <div v-if="auth.isLoggedIn" class="practice__sync-note">
            <template v-if="progress.syncStatus.state === 'synced'">✓ Synchronisiert</template>
            <template v-else-if="progress.syncStatus.state === 'offline'">Offline — wird später synchronisiert</template>
          </div>
        </template>
        <div class="practice__actions-row">
          <QButton variant="secondary" @click="start">Noch eine Sitzung</QButton>
          <QButton @click="router.push('/')">Zur Startseite</QButton>
        </div>
      </div>
    </div>

    <!-- running -->
    <template v-else-if="practice.phase === 'running' && current">
      <div class="practice__body">
        <!-- session rail: this session's questions + current position -->
        <aside class="practice__rail" aria-label="Sitzungsübersicht">
          <div class="practice__rail-head">
            <span class="practice__rail-title">Sitzung</span>
            <span class="practice__rail-count">{{ gradedCount }}/{{ practice.total }}</span>
          </div>
          <ol class="practice__rail-list">
            <li v-for="item in railItems" :key="item.partId">
              <button
                type="button"
                class="practice__rail-item"
                :class="{
                  'practice__rail-item--current': item.state === 'current',
                  'practice__rail-item--done': item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect',
                }"
                :disabled="!item.jumpable && item.state !== 'current'"
                :title="item.state === 'current' ? 'Aktuelle Aufgabe' : item.jumpable ? 'Zu dieser Aufgabe springen' : 'Bereits beantwortet'"
                @click="item.jumpable && practice.jumpTo(item.index)"
              >
                <span class="practice__rail-icon" aria-hidden="true">
                  <StateIcon
                    v-if="item.state === 'correct' || item.state === 'partial' || item.state === 'incorrect'"
                    :state="item.state"
                    :size="15"
                  />
                  <span v-else-if="item.state === 'current'" class="practice__rail-now">→</span>
                  <span v-else class="practice__rail-pending" />
                </span>
                <span class="practice__rail-nr">{{ item.index + 1 }}</span>
                <span class="practice__rail-label">
                  {{ item.title }}<template v-if="item.partLabel"> · {{ item.partLabel }}</template>
                </span>
              </button>
            </li>
          </ol>
        </aside>

        <div class="practice__content">
        <!-- big inline header (feedback #3) -->
        <header class="practice__qheader">
          <div class="practice__qtitle-row">
            <h1 class="practice__qtitle">{{ current.question.title }}</h1>
            <StarButton :starred="currentStarred" @toggle="onStarToggle" />
          </div>
          <div class="practice__qmeta">
            <QChip v-for="c in [...new Set(current.part.competencies.map((x) => x.code))]" :key="c">{{ c }}</QChip>
            <GradingMenu :grading="currentGrading" @select="onGradingSelect" />
            <span class="practice__qsource">{{ sourceLine }}</span>
            <span v-if="current.part.points != null" class="practice__qpoints">{{ current.part.points }} P</span>
          </div>
        </header>

        <div v-if="current.question.prompt && current.question.prompt.length > 0" class="practice__qprompt">
          <RichTextView :nodes="current.question.prompt" />
        </div>

        <PartPlayer
          :key="current.part.id"
          ref="playerRef"
          :part="current.part"
          :label="multiPart ? `Teil ${current.part.label}` : undefined"
          chromeless
          @graded="onGraded"
          @state="onPlayerState"
        />
        </div>
      </div>

      <!-- sticky bottom bar: solution sheet + nav row (feedback #2) -->
      <div
        class="practice__bottombar"
        :class="{
          'practice__bottombar--ok': playerState.result?.verdict === 'correct',
          'practice__bottombar--err': playerState.result != null && playerState.result.verdict === 'incorrect',
          'practice__bottombar--part': playerState.result?.verdict === 'partial' || playerState.phase === 'self-assessing',
        }"
      >
        <SolutionSheet v-model:open="solutionOpen" :solution="current.part.solution" content-max-width="860px" />

        <div class="practice__navrow">
          <div class="practice__navrow-left">
            <ResultPill v-if="playerState.result" :result="playerState.result" />
            <span v-else-if="playerState.phase === 'self-assessing'" class="practice__nav-hint">
              Mit der Lösung vergleichen und selbst bewerten
            </span>
            <span v-else class="practice__nav-hint practice__nav-hint--quiet">Antwort oben eintragen …</span>
          </div>

          <div class="practice__navrow-right">
            <button
              v-if="playerState.phase !== 'answering'"
              type="button"
              class="practice__solution-toggle"
              :class="{ 'practice__solution-toggle--on': solutionOpen }"
              :aria-expanded="solutionOpen"
              @click="solutionOpen = !solutionOpen"
            >
              Lösung <span aria-hidden="true">{{ solutionOpen ? '▾' : '▴' }}</span>
            </button>
            <QButton :disabled="primaryDisabled" @click="primaryAction">{{ primaryLabel }}</QButton>
          </div>
        </div>
      </div>

      <div v-if="practice.warning" class="practice__warning">{{ practice.warning }}</div>
      <div v-if="progress.syncStatus.state === 'offline' && auth.isLoggedIn" class="practice__offline">
        Offline — wird später synchronisiert
      </div>
    </template>
  </div>
</template>

<style scoped>
.practice {
  --practice-rail-width: 240px;
  min-height: 100vh;
  background: var(--q-card);
  display: flex;
  flex-direction: column;
}
.practice__topbar {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--q-border);
  gap: 16px;
  position: sticky;
  top: 0;
  background: var(--q-card);
  z-index: 30;
}
.practice__close {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--q-mut-2);
  font-size: 17px;
  cursor: pointer;
}
.practice__close:hover {
  background: var(--q-panel);
}
.practice__progress {
  flex: 1;
  max-width: 340px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.practice__progress-label {
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  color: var(--q-ink-2);
}
.practice__logo-accent {
  color: var(--q-accent);
}
.practice__progress-track {
  height: 5px;
  border-radius: 3px;
  background: var(--q-track);
  overflow: hidden;
}
.practice__progress-fill {
  height: 100%;
  background: var(--q-accent);
  transition: width 0.3s ease;
}
.practice__spacer {
  width: 34px;
}

.practice__body {
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: stretch;
}

/* session rail — replaces the app nav while practicing (desktop) */
.practice__rail {
  width: var(--practice-rail-width);
  flex: none;
  background: var(--q-panel);
  border-right: 1px solid var(--q-border);
  padding: 16px 10px;
  overflow-y: auto;
  position: sticky;
  top: 56px;
  height: calc(100vh - 56px);
}
.practice__rail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 8px 10px;
}
.practice__rail-title {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--q-faint);
}
.practice__rail-count {
  font: 700 11px ui-monospace, Menlo, monospace;
  color: var(--q-mut-2);
}
.practice__rail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.practice__rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--q-mut);
  font: 500 12px 'Public Sans', system-ui, sans-serif;
  text-align: left;
  cursor: pointer;
}
.practice__rail-item:disabled {
  cursor: default;
}
.practice__rail-item--done {
  color: var(--q-faint);
}
.practice__rail-item--current {
  background: var(--q-accent-bg);
  color: var(--q-ink);
  font-weight: 700;
}
.practice__rail-item:not(:disabled):hover {
  background: var(--q-panel-2);
}
.practice__rail-item--current:hover {
  background: var(--q-accent-bg);
}
.practice__rail-icon {
  width: 16px;
  display: inline-flex;
  justify-content: center;
  flex: none;
}
.practice__rail-now {
  color: var(--q-accent-strong);
  font-weight: 800;
}
.practice__rail-pending {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--q-btn-border);
  display: inline-block;
}
.practice__rail-nr {
  font: 600 10.5px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
  width: 20px;
  flex: none;
  text-align: right;
}
.practice__rail-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1023px) {
  .practice__rail {
    display: none;
  }
}

.practice__content {
  padding: 26px 28px 210px;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  flex: 1;
  min-width: 0;
}

/* big inline header */
.practice__qheader {
  border-bottom: 1px solid var(--q-border);
  padding-bottom: 18px;
  margin-bottom: 20px;
}
.practice__qtitle-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.practice__qtitle {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.02em;
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow-wrap: break-word;
}
.practice__qmeta {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.practice__qsource {
  font-size: 12.5px;
  color: var(--q-mut-2);
  font-weight: 500;
}
.practice__qpoints {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--q-mut-2);
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  padding: 3px 10px;
  border-radius: 20px;
  white-space: nowrap;
}
.practice__qprompt {
  font-size: 15.5px;
  line-height: 1.65;
  margin-bottom: 18px;
}

/* sticky bottom bar */
.practice__bottombar {
  position: fixed;
  bottom: 0;
  left: var(--practice-rail-width);
  right: 0;
  z-index: 40;
  background: var(--q-card);
  border-top: 1px solid var(--q-border);
  border-left: 1px solid var(--q-border);
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.08);
  transition: border-color 0.25s ease;
}
.practice__bottombar--ok {
  border-top-color: var(--q-ok-border);
  background: color-mix(in srgb, var(--q-ok-bg) 35%, var(--q-card));
}
.practice__bottombar--err {
  border-top-color: var(--q-err-border);
  background: color-mix(in srgb, var(--q-err-bg) 35%, var(--q-card));
}
.practice__bottombar--part {
  border-top-color: var(--q-part-border);
  background: color-mix(in srgb, var(--q-part-bg) 35%, var(--q-card));
}
.practice__navrow {
  max-width: 860px;
  margin: 0 auto;
  padding: 12px 28px calc(12px + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 68px;
  flex-wrap: wrap;
}
.practice__navrow-left {
  display: flex;
  align-items: center;
  min-height: 44px;
  min-width: 0;
}
.practice__navrow-right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}
.practice__nav-hint {
  font-size: 12.5px;
  color: var(--q-part-ink);
  font-weight: 600;
}
.practice__nav-hint--quiet {
  color: var(--q-hint);
  font-weight: 400;
  font-style: italic;
}
.practice__solution-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 42px;
  padding: 0 16px;
  border-radius: 9px;
  border: 1px solid var(--q-border-2);
  background: var(--q-card);
  color: var(--q-mut);
  font: 700 11.5px 'Public Sans', system-ui, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.practice__solution-toggle:hover {
  color: var(--q-ink);
  border-color: var(--q-border-3);
}
.practice__solution-toggle--on {
  border-color: var(--q-accent);
  color: var(--q-accent-strong);
  background: var(--q-accent-bg);
}
.practice__warning {
  position: fixed;
  bottom: calc(76px + env(safe-area-inset-bottom));
  left: 50%;
  transform: translateX(-50%);
  max-width: min(90vw, 560px);
  background: var(--q-part-bg);
  border: 1px solid var(--q-part-border);
  color: var(--q-part-ink);
  font-size: 11.5px;
  padding: 6px 12px;
  border-radius: 8px;
  z-index: 41;
}
.practice__offline {
  position: fixed;
  bottom: calc(76px + env(safe-area-inset-bottom));
  left: 0;
  right: 0;
  text-align: center;
  font-size: 11.5px;
  color: var(--q-faint);
  pointer-events: none;
}

/* centered states */
.practice__center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 18px;
}
.practice__skeleton {
  width: 100%;
  max-width: 560px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 12px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.practice__skeleton-bar {
  height: 12px;
  border-radius: 6px;
  background: var(--q-track);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.45;
  }
}
.practice__loading-text {
  font-size: 13px;
  color: var(--q-mut-2);
}
.practice__error {
  max-width: 480px;
  text-align: center;
}
.practice__error-title {
  font-weight: 700;
  font-size: 16px;
  margin-bottom: 8px;
}
.practice__error-text {
  font-size: 13px;
  color: var(--q-mut);
  line-height: 1.55;
  margin-bottom: 18px;
}
.practice__actions-row {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}
.practice__summary {
  width: 100%;
  max-width: 520px;
  text-align: center;
}
.practice__summary-title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0 0 20px;
}
.practice__summary-grid {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.practice__stat {
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 12px;
  padding: 14px 22px;
}
.practice__stat-num {
  font-weight: 800;
  font-size: 26px;
}
.practice__stat-sub {
  font-size: 14px;
  color: var(--q-mut-2);
  font-weight: 600;
}
.practice__stat-label {
  font-size: 11px;
  color: var(--q-faint);
  margin-top: 2px;
}
.practice__stat--verdicts {
  display: flex;
  align-items: center;
  gap: 14px;
}
.practice__verdict {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 15px;
}
.practice__summary-comps {
  display: flex;
  gap: 7px;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.practice__sync-note {
  font-size: 12px;
  color: var(--q-mut-2);
  margin-bottom: 16px;
}

@media (max-width: 640px) {
  .practice__content {
    padding: 18px 16px 230px;
  }
  .practice__qtitle {
    font-size: 24px;
  }
  .practice__navrow {
    padding-left: 16px;
    padding-right: 16px;
  }
  .practice__navrow-right {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 1023px) {
  .practice__bottombar {
    left: 0;
    border-left: none;
  }
}
</style>
