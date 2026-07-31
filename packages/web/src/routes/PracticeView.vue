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
import {
  TEIL_LABELS,
  formatScore,
  TERM_LABELS,
  VERDICT_LABELS_SHORT,
  type ExamPart,
  type GradeResult,
  type Grading,
  type QuestionPart,
  type QuestionsFilter,
  type SelfAssessment,
  type Submission,
  type Term,
} from '@qed2/core-logic';
import {
  PartPlayer,
  FigureList,
  QButton,
  QChip,
  RichTextView,
  AiExplainPanel,
  PracticeBottomBar,
  PracticeQuestionHeader,
  PracticeSessionDrawer,
  PracticeSessionRail,
  SessionProgressBar,
  type SessionItem,
  StateIcon,
  VerdictCard,
  type PartPlayerCommand,
  type PartPlayerState,
  type SheetDetent,
} from '@qed2/ui';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import { useAiStore } from '../stores/ai.js';
import { useAuthStore } from '../stores/auth.js';
import { historyLog } from '../services.js';

const route = useRoute();
const router = useRouter();
const practice = usePracticeStore();
const progress = useProgressStore();
const auth = useAuthStore();


const current = computed(() => practice.current);
/** Verdict per graded part — the segmented top bar's only input besides items. */
const progressGraded = computed(() =>
  practice.graded.map((record) => ({ partId: record.partId, verdict: record.result.verdict })),
);

/* --- PartPlayer shell contract --- */
const playerState = ref<PartPlayerState>({
  phase: 'answering',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  selfAssessment: null,
});
const playerCommand = ref<PartPlayerCommand | null>(null);
let playerCommandId = 0;
/** Solution drawer position. „full" is reachable by swipe only (SolutionSheet). */
const solutionDetent = ref<SheetDetent>('collapsed');
const solutionOpen = computed(() => solutionDetent.value !== 'collapsed');
/** Real sheet height, reported by SolutionSheet — never re-derived here. */
const solutionHeight = ref(0);
/**
 * The real top bar height (56px plus whatever the notch adds), handed to the
 * solution sheet so full screen stops exactly below it. A constant inside the
 * sheet could not see `env(safe-area-inset-top)`.
 */
const topbarEl = ref<HTMLElement | null>(null);
const topbarHeight = ref(0);
let topbarObserver: ResizeObserver | undefined;

function measureTopbar(): void {
  const el = topbarEl.value;
  if (el) topbarHeight.value = Math.ceil(el.getBoundingClientRect().height);
}
/**
 * A grade picked while the part is still unanswered is a pre-declaration, not
 * a review: writing it straight through advanced FSRS once, and answering
 * then advanced it a second time for the same interaction (and overwrote the
 * pick). Held until the verdict exists, it goes through the same override
 * path as a post-answer pick — which rebases on the pre-answer snapshot.
 *
 * Holding it is only safe if every way OUT of the part flushes it first;
 * `flushPendingGrading` is called from each of them. A pick the user made
 * must never be silently dropped — least of all „Ausgeschlossen".
 */
const pendingGrading = ref<Grading | null>(null);

/** Write a held pick through as a standalone review event. */
async function flushPendingGrading(): Promise<void> {
  const grading = pendingGrading.value;
  const partId = current.value?.part.id;
  pendingGrading.value = null;
  if (grading && partId) await practice.overrideGrading(partId, grading);
}

const mobileRailOpen = ref(false);
const exitArmed = ref(false);
const exitButton = ref<HTMLButtonElement | null>(null);

function onPlayerState(state: PartPlayerState): void {
  const wasSelfAssessing = playerState.value.phase === 'self-assessing';
  const wasReviewed = playerState.value.phase === 'reviewed';
  playerState.value = state;
  // Comparing against the official solution is the whole point of
  // self-assessment — open the sheet for the user. Same for a wrong or
  // half-right answer: the people who most need the solution shouldn't
  // have to hunt for the toggle.
  // Full screen, not half: judging means reading the solution AND working
  // the criteria, both of which now live in the sheet. Half would put the
  // controls below the fold on the one step that is nothing but controls.
  if (state.phase === 'self-assessing' && !wasSelfAssessing) solutionDetent.value = 'full';
  if (
    state.phase === 'reviewed' &&
    !wasReviewed &&
    state.result != null
  ) {
    // Coming out of self-assessment the sheet is at full screen and the
    // assessment block has just vanished from under the user; drop back to
    // the reading height so what is left — the solution — is what they see.
    solutionDetent.value =
      wasSelfAssessing || state.result.verdict !== 'correct' ? 'default' : solutionDetent.value;
  }
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
  // The player's own pick wins over one made before answering.
  const manual = payload.manualGrading ?? pendingGrading.value ?? undefined;
  pendingGrading.value = null;
  if (manual) await practice.overrideGrading(payload.partId, manual);
}

/* Double-click / accidental second-tap protection: after „Prüfen" flips the
 * phase synchronously, the same button instantly becomes „Weiter →" — a fast
 * second click would skip the feedback entirely. Ignore repeated activations
 * for a short window after every phase-changing click. */
let lastPrimaryAt = 0;
const PRIMARY_COOLDOWN_MS = 500;

function primaryAction(): void {
  const now = Date.now();
  if (now - lastPrimaryAt < PRIMARY_COOLDOWN_MS) return;
  lastPrimaryAt = now;
  switch (playerState.value.phase) {
    case 'answering':
      playerCommand.value = { id: ++playerCommandId, type: 'submit' };
      break;
    case 'self-assessing':
      playerCommand.value = { id: ++playerCommandId, type: 'confirm-self-assessment' };
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

/* --- AI explanation -------------------------------------------------------
 * Nothing is fetched until the user presses the button: the call costs real
 * money, and most answers do not need explaining.
 */
const ai = useAiStore();

const explainDismissed = ref(new Set<string>());
const explainLoading = ref(false);
const explainError = ref<string | null>(null);

/** The answer text the explanation is about — the same projection the preview shows. */
const explainSubmission = computed(() => playerState.value.answerPreview?.value ?? '');

const showExplain = computed(() => {
  const result = playerState.value.result;
  if (!result || result.verdict === 'correct') return false;
  if (!ai.canExplain) return false;
  return !explainDismissed.value.has(explainKey.value);
});

const explainKey = computed(() => `${current.value?.part.id ?? ''}|${explainSubmission.value}`);

const explainState = computed(() => {
  const hit = current.value ? ai.cached(current.value.part.id, explainSubmission.value) : undefined;
  return {
    markdown: hit?.markdown,
    model: hit?.model,
    source: hit?.source,
    loading: explainLoading.value,
    error: explainError.value ?? undefined,
  };
});

async function askForExplanation(): Promise<void> {
  const part = current.value;
  const result = playerState.value.result;
  if (!part || !result || explainLoading.value) return;
  explainLoading.value = true;
  explainError.value = null;
  try {
    await ai.explain({
      question: part.question,
      part: part.part,
      submitted: explainSubmission.value,
      result,
    });
  } catch (e) {
    explainError.value = explainMessage(e);
  } finally {
    explainLoading.value = false;
  }
}

function dismissExplanation(): void {
  explainDismissed.value = new Set([...explainDismissed.value, explainKey.value]);
  explainError.value = null;
}

/** Turn an API error code into something a student can act on. */
function explainMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case 'AI_NO_CREDENTIAL':
      return 'Kein KI-Schlüssel hinterlegt — unter Optionen einrichten.';
    case 'AI_QUOTA_EXCEEDED':
    case 'AI_PROVIDER_QUOTA':
      return 'Dein KI-Kontingent für diesen Monat ist aufgebraucht.';
    case 'AI_KEY_REJECTED':
      return 'Der KI-Anbieter hat den Schlüssel abgelehnt — bitte unter Optionen prüfen.';
    case 'AI_RATE_LIMITED':
      return 'Zu viele Anfragen — bitte kurz warten.';
    case 'AI_TIMEOUT':
    case 'AI_UNREACHABLE':
      return 'Die KI war nicht erreichbar. Nochmal versuchen?';
    default:
      return 'Die Erklärung konnte nicht erzeugt werden.';
  }
}

function onSelfGradingSelect(grading: Grading): void {
  playerCommand.value = { id: ++playerCommandId, type: 'set-grading', grading };
}

function onSelfAssessmentUpdate(value: SelfAssessment): void {
  playerCommand.value = { id: ++playerCommandId, type: 'set-assessment', assessment: value };
}

/* The verdict lands in the content flow (VerdictCard below the answer
 * control) — scroll it into view so the user actually SEES the feedback
 * instead of discovering it below the fold. */
const verdictAnchor = ref<HTMLElement | null>(null);
watch(
  () => playerState.value.phase,
  (phase) => {
    if (phase !== 'reviewed') return;
    // Wait out the content-padding transition that the auto-opened
    // SolutionSheet triggers (0.3s) — scrolling before the layout settles
    // lands the card behind the sheet again.
    window.setTimeout(() => {
      verdictAnchor.value?.style.setProperty(
        'scroll-margin-bottom',
        `${Math.round(solutionHeight.value) + 90}px`,
      );
      verdictAnchor.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 340);
  },
);

function openSolutionFromVerdict(): void {
  // The sheet is part of the fixed bottom bar — just open it, no scroll
  // (scrolling a fixed element is meaningless).
  solutionDetent.value = 'default';
}

/* --- grading menu + star (ever-present, supplement §1.2/§2) --- */
const currentGrading = computed(
  () =>
    pendingGrading.value ??
    progress.partState.get(current.value?.part.id ?? '')?.grading ??
    'unseen',
);
const currentStarred = computed(
  () => progress.partState.get(current.value?.part.id ?? '')?.starred ?? false,
);

async function onGradingSelect(grading: Grading): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId) return;
  if (playerState.value.phase === 'answering') {
    pendingGrading.value = grading;
    return;
  }
  pendingGrading.value = null;
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
  void (async () => {
    const hasQuery = route.query.source === 'history' || typeof route.query.questions === 'string' || typeof route.query.year === 'string'
      || typeof route.query.term === 'string' || typeof route.query.part === 'string' || typeof route.query.gk === 'string';
    // Explicit deep links always (re)start.
    if (hasQuery) {
      await start();
      return;
    }
    // Bulk handoff from the Aufgaben list: the session is already seeded in
    // the store, so adopt it whatever its origin.
    if (route.query.prepared === '1') {
      if (await practice.restoreSession()) return;
      await start();
      return;
    }
    // Plain /practice — the navigation's „Programm üben". Resume only a
    // programme; a hand-picked set left over from the Aufgaben list is not
    // what was asked for, so it yields to a fresh recommendation.
    if (await practice.restoreSession('smart')) return;
    await start();
  })();
});

watch(
  () => practice.index,
  () => {
    solutionDetent.value = 'collapsed';
    mobileRailOpen.value = false;
    exitArmed.value = false;
    playerCommand.value = null;
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

/** Leaving must never hang on the network. */
const EXIT_SYNC_GRACE_MS = 2500;

async function exitNow(): Promise<void> {
  // Everything that must be attempted before leaving goes INSIDE the race:
  // finishSession persists (fast, local) then syncs (arbitrary network), and
  // a storage write can hang or reject too. A dead-but-accepting server used
  // to leave the user staring at a screen that did nothing; the outbox and
  // the archive are durable, so leaving early loses nothing.
  await Promise.race([
    (async () => {
      await flushPendingGrading();
      await practice.finishSession();
    })().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, EXIT_SYNC_GRACE_MS)),
  ]);
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
  if (ev.key !== 'ArrowRight') return;
  // Never steal arrows from native controls (selects, menus, text fields) —
  // they need them for their own keyboard navigation.
  const target = ev.target as HTMLElement | null;
  if (target?.closest('input, select, textarea, [contenteditable="true"], [role="menu"], [role="listbox"]'))
    return;
  if (playerState.value.phase === 'reviewed' && practice.phase === 'running') {
    ev.preventDefault();
    practice.next();
  }
}
onMounted(() => {
  measureTopbar();
  window.addEventListener('resize', measureTopbar);
  if (typeof ResizeObserver !== 'undefined' && topbarEl.value) {
    topbarObserver = new ResizeObserver(measureTopbar);
    topbarObserver.observe(topbarEl.value);
  }
});
onMounted(() => window.addEventListener('keydown', onKeydown));
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', measureTopbar);
  topbarObserver?.disconnect();
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  // Browser/Android back leaves the route without going through exitNow, and
  // a held pick must never be dropped silently. Fire-and-forget is the best
  // available here — the write is local and the component is going away.
  void flushPendingGrading();
});

const multiPart = computed(() => (current.value?.question.parts.length ?? 0) > 1);
/** The VerdictCard is only shown where the control's OWN review state does
 *  not already spell out the verdict inline. Choice/matching/numeric/
 *  interval/expression all render per-option/per-blank ok·err marks plus
 *  the expected answer — a big card below would just repeat them. `open`
 *  parts (self-assessed) have no inline verdict, so they keep the card. */
const showVerdictCard = computed(
  () =>
    playerState.value.phase === 'reviewed' &&
    playerState.value.result != null &&
    current.value?.part.answer?.kind === 'open',
);
const summaryStats = computed(() => practice.summary);

/** Score as a percentage for the result meter (0 max points → empty, not NaN). */
const scorePct = computed(() => {
  const { points, maxPoints } = summaryStats.value;
  return maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0;
});

/** Verdict counts, always all three, so the row keeps its shape. */
const summaryVerdictRows = computed(() => {
  const by = summaryStats.value.byVerdict;
  return [
    { state: 'correct' as const, count: by.correct, label: VERDICT_LABELS_SHORT.correct },
    { state: 'partial' as const, count: by.partial, label: VERDICT_LABELS_SHORT.partial },
    { state: 'incorrect' as const, count: by.incorrect, label: VERDICT_LABELS_SHORT.incorrect },
  ];
});

const syncNote = computed(() => {
  switch (progress.syncStatus.state) {
    case 'synced':
      return '✓ Synchronisiert';
    case 'offline':
      return 'Offline — wird später synchronisiert';
    default:
      return '';
  }
});
const showProgramRail = computed(() => practice.total > 1);

/* --- session rail (left sidebar): the session's items + current position --- */
const railItems = computed<SessionItem[]>(() => {
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
  void flushPendingGrading();
  practice.jumpTo(index);
  mobileRailOpen.value = false;
}

const gradedCount = computed(() => practice.graded.length);
const sourceLine = computed(() => {
  const q = current.value?.question;
  if (!q) return '';
  return `${TERM_LABELS[q.source.term]} ${q.source.year} · ${TEIL_LABELS[q.source.part]}`;
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
  <div
    class="practice q-app"
    :class="{ 'practice--no-rail': !showProgramRail }"
    :style="{
      '--practice-sheet-height': `${Math.round(solutionHeight)}px`,
      ...(topbarHeight > 0 ? { '--practice-topbar-height': `${topbarHeight}px` } : {}),
    }"
  >
    <!-- top bar -->
    <div ref="topbarEl" class="practice__topbar">
      <button
        ref="exitButton"
        type="button"
        class="practice__close"
        :class="{ 'practice__close--armed': exitArmed }"
        :aria-label="exitArmed ? 'Programm verlassen bestätigen' : 'Programm verlassen'"
        @click.stop="exit"
      >
        <span class="practice__close-mark" aria-hidden="true">✕</span>
        <span v-if="exitArmed" class="practice__close-text">Beenden?</span>
      </button>
      <div class="practice__progress">
        <div class="practice__progress-label">
          <template v-if="practice.phase === 'running'">Aufgabe {{ practice.index + 1 }} von {{ practice.total }}</template>
          <template v-else-if="practice.phase === 'summary'">Programm abgeschlossen</template>
          <template v-else>QED<span class="practice__logo-accent">2</span></template>
        </div>
        <SessionProgressBar
          :items="practice.items"
          :graded="progressGraded"
          :current-index="practice.index"
          :active="practice.phase === 'running'"
        />
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

    <div class="practice__stage q-crossfade">
    <transition name="q-crossfade">
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
            <QButton @click="practice.retry()">Erneut versuchen</QButton>
          </div>
        </div>
      </div>

      <!-- summary -->
      <div v-else-if="practice.phase === 'summary'" key="summary" class="practice__center">
        <div v-if="summaryStats.count === 0" class="practice__summary">
          <p class="practice__summary-empty">
            Keine passenden Aufgaben gefunden — andere Filter probieren?
          </p>
          <QButton class="practice__summary-cta" @click="exitNow">Zurück</QButton>
        </div>

        <div v-else class="practice__summary">
          <!-- One card instead of three floating boxes: the score is the
               headline, everything else supports it. -->
          <section class="practice__result">
            <div class="practice__result-score">
              <span class="practice__result-points">{{ formatScore(summaryStats.points) }}</span>
              <span class="practice__result-max">von {{ formatScore(summaryStats.maxPoints) }} Punkten</span>
            </div>
            <div class="practice__result-meter" role="img" :aria-label="`${scorePct} Prozent erreicht`">
              <span class="practice__result-meter-fill" :style="{ width: `${scorePct}%` }" />
            </div>
            <p class="practice__result-count">
              {{ summaryStats.count }} {{ summaryStats.count === 1 ? 'Aufgabe' : 'Aufgaben' }} bearbeitet
            </p>

            <ul class="practice__result-verdicts">
              <li v-for="row in summaryVerdictRows" :key="row.state" class="practice__result-verdict">
                <StateIcon :state="row.state" :size="18" />
                <span class="practice__result-verdict-num">{{ row.count }}</span>
                <span class="practice__result-verdict-label">{{ row.label }}</span>
              </li>
            </ul>

            <div v-if="summaryStats.competencies.length > 0" class="practice__result-section">
              <h3 class="practice__result-section-title">Geübte Kompetenzen</h3>
              <div class="practice__result-comps">
                <QChip v-for="c in summaryStats.competencies" :key="c">{{ c }}</QChip>
              </div>
            </div>

            <p v-if="auth.isLoggedIn && syncNote" class="practice__result-sync">{{ syncNote }}</p>
          </section>

          <QButton class="practice__summary-cta" @click="exitNow">Zurück</QButton>
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

          <div class="practice__content" :class="{ 'practice__content--sheet-open': solutionOpen }">
            <PracticeQuestionHeader
              :title="current.question.title"
              :competency-codes="currentCompetencyCodes"
              :source-line="sourceLine"
              :points="current.part.points"
              :format="current.part.format"
              :starred="currentStarred"
              :official-url="officialAufgabenpoolUrl"
              @star-toggle="onStarToggle"
            />

            <div v-if="current.question.prompt && current.question.prompt.length > 0" class="practice__qprompt">
              <RichTextView :nodes="current.question.prompt" />
            </div>
            <FigureList :figures="current.question.figures" />

            <PartPlayer
              :key="current.part.id"
              :part="current.part"
              :label="multiPart ? `Teil ${current.part.label}` : undefined"
              :command="playerCommand"
              chromeless
              @graded="onGraded"
              @state="onPlayerState"
            />

            <!-- The authoritative grade feedback lives HERE, in the scroll
                 flow under the answer — but only for kinds without inline
                 verdict marks (open); everything else feeds back in place. -->
            <div v-if="showVerdictCard" ref="verdictAnchor">
              <VerdictCard
                :key="current.part.id"
                :result="playerState.result!"
                class="practice__verdict"
                @view-solution="openSolutionFromVerdict"
              />
            </div>

          </div>
        </div>

        <PracticeBottomBar
          v-model:solution-detent="solutionDetent"
          @update:solution-height="solutionHeight = $event"
          :top-reserve="topbarHeight"
          :state="playerState"
          :answer-preview="playerState.answerPreview"
          :scoring="current.part.scoring"
          :rubric="current.part.answer?.kind === 'open' ? current.part.answer.rubric : undefined"
          :solution="current.part.solution"
          :grading="currentGrading"
          :primary-label="primaryLabel"
          :primary-disabled="primaryDisabled"
          @assessment-update="onSelfAssessmentUpdate"
          @self-grading-select="onSelfGradingSelect"
          @grading-select="onGradingSelect"
          @primary="primaryAction"
        >
          <!-- Offered only for a wrong or half-right answer, and only once the
               account can actually pay for it (see aiStore.canExplain). -->
          <template v-if="showExplain" #explain>
            <AiExplainPanel
              :markdown="explainState.markdown"
              :loading="explainState.loading"
              :error="explainState.error"
              :model="explainState.model"
              :source="explainState.source"
              @ask="askForExplanation"
              @dismiss="dismissExplanation"
            />
          </template>
        </PracticeBottomBar>

        <div v-if="practice.warning" class="practice__warning" role="alert">{{ practice.warning }}</div>
        <div v-if="progress.syncStatus.state === 'offline' && auth.isLoggedIn" class="practice__offline">
          Offline — wird später synchronisiert
        </div>
      </div>
    </transition>
    </div>
  </div>
</template>

<style scoped>
.practice {
  --practice-rail-width: var(--q-sidebar-width);
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--q-card);
  display: flex;
  flex-direction: column;
}
.practice--no-rail {
  --practice-rail-width: 0px;
}
/* Stacks the phase panels so loading and content overlap during the swap
 * instead of leaving the screen briefly empty. */
.practice__stage {
  flex: 1;
  min-height: 0;
}
.practice__topbar {
  height: calc(56px + env(safe-area-inset-top));
  display: flex;
  align-items: center;
  padding: env(safe-area-inset-top) 16px 0;
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
@media (hover: hover) and (pointer: fine) {
  .practice__close:hover {
    background: var(--q-panel);
  }
}
.practice__close--armed {
  width: 88px;
  background: var(--q-err-bg);
  color: var(--q-err);
  font-weight: 800;
}
@media (hover: hover) and (pointer: fine) {
  .practice__close--armed:hover {
    background: var(--q-err-bg);
  }
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
/* The track itself is PracticeProgressBar's business now. */
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
@media (hover: hover) and (pointer: fine) {
  .practice__session-button:hover {
    background: var(--q-panel);
  }
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
  /* The keyboard inset is added to the bottom reserve, not just to the bar:
   * once the bar lifts, the answer field under it needs the same room. */
  padding: 26px 28px calc(210px + var(--q-keyboard-inset, 0px));
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
  flex: 1;
  min-width: 0;
  transition: padding-bottom 0.3s ease;
}
/* SolutionSheet is fixed above the bar — while it's open, the content must
 * clear the sheet plus the bar (~110px) or feedback hides behind it. The
 * height comes from the sheet itself (--practice-sheet-height); re-deriving
 * it here went stale the moment the detent became content-measured.
 * (doubled class beats the ≤640px padding override below regardless of
 * source order) */
.practice__content.practice__content--sheet-open {
  padding-bottom: calc(
    var(--practice-sheet-height, 0px) + 110px + var(--q-keyboard-inset, 0px)
  );
}
.practice__verdict {
  margin-top: 16px;
  scroll-margin-bottom: 140px; /* keep clear of the fixed bottom bar */
}

.practice__qprompt {
  font-size: 15.5px;
  line-height: 1.65;
  margin-bottom: 18px;
  /* wide inline KaTeX scrolls here instead of panning the whole page */
  overflow-x: auto;
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
/* --- programme result ------------------------------------------------------
 * One card carrying the whole outcome. The previous version scattered three
 * differently-sized boxes, a chip row and a sync line across the middle of an
 * otherwise empty screen; nothing lined up and the heading merely repeated
 * the top bar.
 */
.practice__summary {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.practice__summary-empty {
  margin: 0;
  text-align: center;
  color: var(--q-mut);
  font-size: 14px;
}
.practice__summary-cta {
  align-self: stretch;
}

.practice__result {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 26px 22px 22px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 16px;
  box-shadow: var(--q-shadow-card);
}

/* The score is the headline — the top bar already said „abgeschlossen". */
.practice__result-score {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.practice__result-points {
  font-size: 44px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.practice__result-max {
  font-size: 13px;
  color: var(--q-mut-2);
  font-weight: 600;
}
.practice__result-meter {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--q-track);
  overflow: hidden;
}
.practice__result-meter-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--q-accent);
  transition: width var(--q-transition-normal);
}
.practice__result-count {
  margin: 0;
  font-size: 12.5px;
  color: var(--q-faint);
}

/* Equal columns so the three counts read as one comparison, not three cards. */
.practice__result-verdicts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  margin: 2px 0 0;
  padding: 14px 0 0;
  border-top: 1px solid var(--q-border-soft);
  list-style: none;
}
.practice__result-verdict {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.practice__result-verdict-num {
  font-size: 19px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.practice__result-verdict-label {
  font-size: 11px;
  color: var(--q-faint);
}

.practice__result-section {
  width: 100%;
  padding-top: 14px;
  border-top: 1px solid var(--q-border-soft);
}
.practice__result-section-title {
  margin: 0 0 9px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--q-faint);
  text-align: center;
}
.practice__result-comps {
  display: flex;
  gap: 7px;
  justify-content: center;
  flex-wrap: wrap;
}
.practice__result-sync {
  margin: 0;
  font-size: 12px;
  color: var(--q-mut-2);
}

@media (max-width: 640px) {
  .practice__content {
    padding: 18px 16px calc(300px + var(--q-keyboard-inset, 0px));
  }
}

@media (max-width: 1023px) {
  .practice__session-button {
    visibility: visible;
  }
}

@media (pointer: coarse) {
  /* 44px touch targets in the always-visible chrome (fits the 56px topbar);
     min-width so the armed close button keeps its 88px width. */
  .practice__close,
  .practice__session-button,
  .practice__spacer {
    min-width: 44px;
    height: 44px;
  }
}
</style>
