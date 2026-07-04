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
  PartPlayer,
  QButton,
  QChip,
  RichTextView,
  StateIcon,
  type PartPlayerState,
} from '@qed2/ui';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import { useAuthStore } from '../stores/auth.js';
import { historyLog } from '../services.js';
import PracticeBottomBar from './practice/PracticeBottomBar.vue';
import PracticeQuestionHeader from './practice/PracticeQuestionHeader.vue';
import PracticeSessionDrawer from './practice/PracticeSessionDrawer.vue';
import PracticeSessionRail from './practice/PracticeSessionRail.vue';

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
  answerPreview: null,
  selfAssessment: null,
});
const solutionOpen = ref(false);
const mobileRailOpen = ref(false);
const exitArmed = ref(false);
const exitButton = ref<HTMLButtonElement | null>(null);

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
  manualGrading?: Grading;
}): Promise<void> {
  const part: QuestionPart | undefined = current.value?.part;
  if (!part || part.id !== payload.partId) return;
  await practice.recordGraded({ part, result: payload.result, submission: payload.submission });
  if (payload.manualGrading) await practice.overrideGrading(payload.partId, payload.manualGrading);
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
  () => {
    if (playerState.value.phase === 'answering') return !playerState.value.canSubmit;
    if (playerState.value.phase === 'self-assessing') {
      const self = playerState.value.selfAssessment;
      return self?.selectedPoints == null || self.grading == null;
    }
    return false;
  },
);

function onSelfScoreSelect(points: number): void {
  playerRef.value?.setSelfAssessmentScore(points);
}

function onSelfGradingSelect(grading: Grading): void {
  playerRef.value?.setSelfAssessmentGrading(grading);
}

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
  if (q.source === 'history') {
    void startHistoryProgram();
    return;
  }
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

async function startHistoryProgram(): Promise<void> {
  const q = route.query;
  const focusQuestionId = typeof q.focus === 'string' ? q.focus : undefined;
  let questionIds =
    typeof q.questions === 'string' && q.questions.length > 0
      ? q.questions.split(',').filter(Boolean)
      : [];

  if (questionIds.length === 0) {
    const recent = await historyLog.list(80, 0);
    questionIds = [...new Set(recent.map((entry) => entry.questionId))];
  }
  if (focusQuestionId && !questionIds.includes(focusQuestionId)) questionIds.unshift(focusQuestionId);
  await practice.startQuestions(questionIds);
  if (focusQuestionId) {
    const idx = practice.items.findIndex((item) => item.questionId === focusQuestionId);
    if (idx > 0) practice.jumpTo(idx);
  }
}

onMounted(() => {
  const hasQuery = route.query.source === 'history' || typeof route.query.questions === 'string' || typeof route.query.year === 'string'
    || typeof route.query.term === 'string' || typeof route.query.part === 'string' || typeof route.query.gk === 'string';
  // Explicit deep links always (re)start; otherwise respect a session the
  // browse page already seeded in the store (loading/running handoff).
  if (hasQuery || (practice.phase !== 'running' && practice.phase !== 'loading')) start();
});

watch(
  () => practice.index,
  () => {
    solutionOpen.value = false;
    mobileRailOpen.value = false;
    exitArmed.value = false;
    window.scrollTo({ top: 0 });
  },
);

function localReturnPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/practice')) return undefined;
  return value;
}

function returnTarget(): string {
  const queryReturn = Array.isArray(route.query.returnTo) ? route.query.returnTo[0] : route.query.returnTo;
  return localReturnPath(queryReturn) ?? localReturnPath(router.options.history.state.back) ?? '/';
}

async function exitNow(): Promise<void> {
  await practice.finishSession();
  practice.abort();
  void router.replace(returnTarget());
}

function exit(): void {
  if (!exitArmed.value) {
    exitArmed.value = true;
    return;
  }
  void exitNow();
}

function onDocumentPointerDown(ev: PointerEvent): void {
  if (!exitArmed.value) return;
  const target = ev.target;
  if (target instanceof Node && exitButton.value?.contains(target)) return;
  exitArmed.value = false;
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowRight' && playerState.value.phase === 'reviewed' && practice.phase === 'running') {
    ev.preventDefault();
    practice.next();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});

const multiPart = computed(() => (current.value?.question.parts.length ?? 0) > 1);
const summaryStats = computed(() => practice.summary);
const showProgramRail = computed(() => practice.total > 1);

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

function jumpToSessionItem(index: number): void {
  practice.jumpTo(index);
  mobileRailOpen.value = false;
}

const gradedCount = computed(() => practice.graded.length);
const sourceLine = computed(() => {
  const q = current.value?.question;
  if (!q) return '';
  return `${TERM_LABELS[q.source.term]} ${q.source.year} · ${q.source.part === 't1' ? 'Teil 1' : 'Teil 2'}`;
});
const officialAufgabenpoolUrl = computed(() => {
  const refs = current.value?.question.externalRefs ?? [];
  for (const ref of refs) {
    if (
      ref &&
      typeof ref === 'object' &&
      'system' in ref &&
      'url' in ref &&
      ref.system === 'aufgabenpool' &&
      typeof ref.url === 'string' &&
      ref.url.length > 0
    ) {
      return ref.url;
    }
  }
  return null;
});
const currentCompetencyCodes = computed(() =>
  [...new Set(current.value?.part.competencies.map((x) => x.code) ?? [])],
);
</script>

<template>
  <div class="practice q-app" :class="{ 'practice--no-rail': !showProgramRail }">
    <!-- top bar -->
    <div class="practice__topbar">
      <button
        ref="exitButton"
        type="button"
        class="practice__close"
        :class="{ 'practice__close--armed': exitArmed }"
        :aria-label="exitArmed ? 'Programm verlassen bestätigen' : 'Programm verlassen'"
        @click.stop="exit"
      >
        <span class="practice__close-mark" aria-hidden="true">✕</span>
        <span v-if="exitArmed" class="practice__close-text">exit?</span>
      </button>
      <div class="practice__progress">
        <div class="practice__progress-label">
          <template v-if="practice.phase === 'running'">Aufgabe {{ practice.index + 1 }} von {{ practice.total }}</template>
          <template v-else-if="practice.phase === 'summary'">Programm abgeschlossen</template>
          <template v-else>QED<span class="practice__logo-accent">2</span></template>
        </div>
        <div class="practice__progress-track">
          <div class="practice__progress-fill" :style="{ width: `${practice.phase === 'summary' ? 100 : progressPct}%` }" />
        </div>
      </div>
      <button
        v-if="practice.phase === 'running' && showProgramRail"
        type="button"
        class="practice__session-button"
        aria-label="Programmliste öffnen"
        @click="mobileRailOpen = true"
      >
        ☰
      </button>
      <span v-else class="practice__spacer" />
    </div>

    <transition name="page-fade" mode="out-in">
      <!-- loading -->
      <div v-if="practice.phase === 'loading'" key="loading" class="practice__center">
        <div class="practice__skeleton">
          <div class="practice__skeleton-bar" style="width: 40%" />
          <div class="practice__skeleton-bar" style="width: 90%" />
          <div class="practice__skeleton-bar" style="width: 75%" />
          <div class="practice__skeleton-bar" style="width: 85%" />
        </div>
        <div class="practice__loading-text">Aufgaben werden geladen …</div>
      </div>

      <!-- error -->
      <div v-else-if="practice.phase === 'error'" key="error" class="practice__center">
        <div class="practice__error">
          <div class="practice__error-title">Aufgaben konnten nicht geladen werden</div>
          <div class="practice__error-text">
            {{ practice.error }} — ist der Inhalts-Server erreichbar? (Einstellungen → Serveradressen)
          </div>
          <div class="practice__actions-row">
            <QButton variant="secondary" @click="exitNow">Zurück</QButton>
            <QButton @click="start">Erneut versuchen</QButton>
          </div>
        </div>
      </div>

      <!-- summary -->
      <div v-else-if="practice.phase === 'summary'" key="summary" class="practice__center">
        <div class="practice__summary">
          <h2 class="practice__summary-title">Programm abgeschlossen</h2>
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
            <QButton variant="secondary" @click="start">Noch ein Programm</QButton>
            <QButton @click="exitNow">Zurück</QButton>
          </div>
        </div>
      </div>

      <!-- running -->
      <div v-else-if="practice.phase === 'running' && current" key="running" class="practice__running">
        <div class="practice__body">
          <PracticeSessionRail
            v-if="showProgramRail"
            :items="railItems"
            :graded-count="gradedCount"
            :total="practice.total"
            @jump="jumpToSessionItem"
          />

          <PracticeSessionDrawer
            v-if="showProgramRail"
            :open="mobileRailOpen"
            :items="railItems"
            :graded-count="gradedCount"
            :total="practice.total"
            @close="mobileRailOpen = false"
            @jump="jumpToSessionItem"
          />

          <div class="practice__content">
            <PracticeQuestionHeader
              :title="current.question.title"
              :competency-codes="currentCompetencyCodes"
              :grading="currentGrading"
              :source-line="sourceLine"
              :points="current.part.points"
              :format="current.part.format"
              :starred="currentStarred"
              :official-url="officialAufgabenpoolUrl"
              @grading-select="onGradingSelect"
              @star-toggle="onStarToggle"
            />

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

        <PracticeBottomBar
          v-model:solution-open="solutionOpen"
          :state="playerState"
          :answer-preview="playerState.answerPreview"
          :solution="current.part.solution"
          :primary-label="primaryLabel"
          :primary-disabled="primaryDisabled"
          @score-select="onSelfScoreSelect"
          @grading-select="onSelfGradingSelect"
          @primary="primaryAction"
        />

        <div v-if="practice.warning" class="practice__warning">{{ practice.warning }}</div>
        <div v-if="progress.syncStatus.state === 'offline' && auth.isLoggedIn" class="practice__offline">
          Offline — wird später synchronisiert
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.practice {
  --practice-rail-width: var(--q-sidebar-width);
  min-height: 100vh;
  background: var(--q-card);
  display: flex;
  flex-direction: column;
}
.practice--no-rail {
  --practice-rail-width: 0px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  overflow: hidden;
  transition:
    width 0.16s ease,
    color 0.16s ease,
    background 0.16s ease;
}
.practice__close:hover {
  background: var(--q-panel);
}
.practice__close--armed {
  width: 88px;
  background: var(--q-err-bg);
  color: var(--q-err);
  font-weight: 800;
}
.practice__close--armed:hover {
  background: var(--q-err-bg);
}
.practice__close-mark {
  flex: none;
}
.practice__close-text {
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
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
.practice__session-button {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: none;
  background: none;
  color: var(--q-mut-2);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  visibility: hidden;
}
.practice__session-button:hover {
  background: var(--q-panel);
}

.practice__running {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.practice__body {
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: stretch;
}

.practice__content {
  padding: 26px 28px 210px;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  flex: 1;
  min-width: 0;
}

.practice__qprompt {
  font-size: 15.5px;
  line-height: 1.65;
  margin-bottom: 18px;
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
    padding: 18px 16px 300px;
  }
}

@media (max-width: 1023px) {
  .practice__session-button {
    visibility: visible;
  }
}
</style>
