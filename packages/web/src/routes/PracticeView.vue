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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { Cloud, HardDrive } from 'lucide-vue-next';
import {
  type AiAssessResult,
  type AiExplainResult,
  type AiRequestContext,
  TEIL_LABELS,
  formatScore,
  TERM_LABELS,
  VERDICT_LABELS_SHORT,
  type ExamPart,
  type GradeResult,
  type Grading,
  type QuestionPart,
  type QuestionsFilter,
  type RichText,
  type SelfAssessment,
  type Submission,
  type Term,
} from '@qed2/core-logic';
import {
  PartPlayer,
  FigureList,
  QButton,
  QIconButton,
  RichTextView,
  AiAssessPanel,
  AiLearningPanel,
  PracticeBottomBar,
  PracticeQuestionHeader,
  PracticeSessionDrawer,
  PracticeSessionRail,
  provideAssetResolver,
  SessionProgressBar,
  type SessionItem,
  StateIcon,
  VerdictCard,
  type PartPlayerCommand,
  type PartPlayerDraft,
  type PartPlayerState,
  type SheetDetent,
} from '@qed2/ui';
import { usePracticeStore } from '../stores/practice.js';
import { useProgressStore } from '../stores/progress.js';
import { useAiStore } from '../stores/ai.js';
import { useAuthStore } from '../stores/auth.js';
import { historyLog, ports } from '../services.js';
import { shortCommit } from '../version-info.js';

const route = useRoute();
const router = useRouter();
const practice = usePracticeStore();
const progress = useProgressStore();
const auth = useAuthStore();

// Practice owns an immutable content source for its whole session. Override
// App.vue's live resolver for this subtree so figures cannot jump to another
// Core when a different Desktop window changes the device preference.
provideAssetResolver((src) => practice.assetUrl(src));


const current = computed(() => practice.current);
/** Verdict per graded part — the segmented top bar's only input besides items. */
const progressGraded = computed(() =>
  practice.graded.map((record) => ({ partId: record.partId, verdict: record.result.verdict })),
);

/* --- PartPlayer shell contract --- */
const playerState = ref<PartPlayerState>({
  phase: 'answering',
  attemptPhase: 'first',
  canSubmit: false,
  result: null,
  firstResult: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  submittedText: '',
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
 * The pick is stored on the account-scoped session item immediately. It does
 * not advance FSRS by itself; returning to the part restores it, and the one
 * later answer commit applies it atomically.
 */
const pendingGrading = ref<Grading | null>(null);
const pendingGradingSaveBusy = ref(false);
const pendingGradingSaveError = ref<string | null>(null);
let pendingGradingSaveSequence = 0;
type GradeCommitPayload = {
  partId: string;
  result: GradeResult;
  submission: Submission;
  selfAssessed: boolean;
  manualGrading?: Grading;
};
type CorrectionCommitPayload = Omit<GradeCommitPayload, 'manualGrading'>;
const commitBusy = ref(false);
const commitError = ref<string | null>(null);
const pendingGradeCommit = ref<GradeCommitPayload | null>(null);
const pendingCorrectionCommit = ref<CorrectionCommitPayload | null>(null);
const pendingOverrideGrading = ref<Grading | null>(null);
const selfAssessmentDraftDurable = ref(false);
const selfAssessmentDraftError = ref<string | null>(null);
const pendingSelfAssessmentDraft = ref<PartPlayerDraft | null>(null);
let draftSaveSequence = 0;
let selfAssessmentFocusPending = false;
const correctionDraftSaveBusy = ref(false);
const correctionDraftError = ref<string | null>(null);
const pendingCorrectionDraft = ref<Submission | null>(null);
let correctionDraftSaveSequence = 0;
const answerDraftSaveBusy = ref(false);
const answerDraftSaveError = ref<string | null>(null);
const pendingAnswerDraft = ref<Submission | null>(null);
let answerDraftSaveSequence = 0;
let answerDraftSavePromise: ReturnType<typeof practice.saveAnswerDraft> | undefined;

const mobileRailOpen = ref(false);
const mobileSourceFooterReady = ref(false);
const exitArmed = ref(false);
const provenanceHeading = ref<HTMLHeadingElement | null>(null);

/**
 * The drawer is owned by @qed2/ui and intentionally has no product-specific
 * content. Wait until its panel exists, then append this view's provenance
 * footer to that panel. This keeps the Web/Desktop distinction in the Web
 * shell and avoids teaching the shared list component about platform ports.
 */
watch(mobileRailOpen, async (open) => {
  mobileSourceFooterReady.value = false;
  if (!open) return;
  await nextTick();
  mobileSourceFooterReady.value =
    mobileRailOpen.value && document.querySelector('.practice-session-drawer__panel') !== null;
});

watch(
  () => practice.phase,
  async (phase) => {
    if (phase !== 'provenance-choice') return;
    await nextTick();
    provenanceHeading.value?.focus();
  },
  { flush: 'post' },
);

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
  if (state.phase === 'self-assessing' && !wasSelfAssessing) {
    selfAssessmentFocusPending = true;
    selfAssessmentDraftDurable.value = Boolean(practice.currentSelfAssessmentDraft);
    solutionDetent.value = 'full';
  }
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

async function onPlayerDraft(draft: PartPlayerDraft): Promise<void> {
  const partId = current.value?.part.id;
  // This typed event is emitted only after PartPlayer has entered its own
  // self-assessment state. Its state projection is delivered by a separate
  // watcher and can still be one Vue tick behind here, so treating that mirror
  // as a guard would discard the first (and crash-critical) draft.
  if (!partId) return;
  pendingSelfAssessmentDraft.value = draft;
  const sequence = ++draftSaveSequence;
  selfAssessmentDraftDurable.value = false;
  selfAssessmentDraftError.value = null;
  const saved = await practice.saveSelfAssessmentDraft(partId, draft).catch(() => false);
  if (sequence === draftSaveSequence && current.value?.part.id === partId) {
    selfAssessmentDraftDurable.value = saved;
    selfAssessmentDraftError.value = saved
      ? null
      : 'Die Selbstbewertung konnte nicht lokal gespeichert werden.';
    if (saved && selfAssessmentFocusPending) {
      selfAssessmentFocusPending = false;
      await nextTick();
      document.querySelector<HTMLElement>(
        '.q-selfassess button:not([disabled]), .q-selfassess [tabindex="0"]',
      )?.focus();
    }
  }
}

function retrySelfAssessmentDraft(): void {
  const draft = pendingSelfAssessmentDraft.value;
  if (draft) void onPlayerDraft(draft);
}

async function onCorrectionDraft(submission: Submission): Promise<void> {
  const partId = current.value?.part.id;
  const attemptId = firstAttemptId.value;
  if (!partId || !attemptId || playerState.value.attemptPhase !== 'correction') return;
  pendingCorrectionDraft.value = submission;
  const sequence = ++correctionDraftSaveSequence;
  correctionDraftSaveBusy.value = true;
  correctionDraftError.value = null;
  const saved = await practice.saveCorrectionDraft(attemptId, partId, submission).catch(() => false);
  if (
    sequence === correctionDraftSaveSequence
    && current.value?.part.id === partId
    && firstAttemptId.value === attemptId
  ) {
    correctionDraftSaveBusy.value = false;
    correctionDraftError.value = saved
      ? null
      : 'Die Korrektur konnte nicht lokal zwischengespeichert werden.';
  }
}

function onAnswerDraft(submission: Submission): void {
  const partId = current.value?.part.id;
  if (!partId || playerState.value.phase !== 'answering' || playerState.value.attemptPhase !== 'first') return;
  pendingAnswerDraft.value = submission;
  const sequence = ++answerDraftSaveSequence;
  answerDraftSaveBusy.value = true;
  answerDraftSaveError.value = null;
  // Enter the profile-bound session queue before yielding. A profile switch
  // or component unmount may stop this view from publishing UI state, but it
  // must never cancel or retarget the already captured local draft write.
  const operation = practice.saveAnswerDraft(partId, submission)
    .catch(() => ({ status: 'failed' as const }));
  answerDraftSavePromise = operation;
  void operation.then((outcome) => {
    if (answerDraftSavePromise === operation) answerDraftSavePromise = undefined;
    if (sequence !== answerDraftSaveSequence || current.value?.part.id !== partId) return;
    answerDraftSaveBusy.value = false;
    if (outcome.status === 'superseded-by-grade') {
      const record = outcome.record;
      firstAttemptId.value = record.clientAttemptId;
      hintLevel.value = record.hintLevel ?? 0;
      correctionOutcome.value = record.correctionOutcome ?? null;
      playerCommand.value = {
        id: ++playerCommandId,
        type: 'restore-review',
        result: record.result,
        ...(record.pendingSubmission ? { submission: record.pendingSubmission } : {}),
        ...(!record.pendingSubmission ? { submissionUnavailable: true } : {}),
      };
      answerDraftSaveError.value = null;
      pendingAnswerDraft.value = null;
      return;
    }
    answerDraftSaveError.value = outcome.status === 'saved'
      ? null
      : 'Der Antwortentwurf konnte nicht lokal gespeichert werden.';
    if (outcome.status === 'saved') pendingAnswerDraft.value = null;
  });
}

async function flushAnswerDraft(): Promise<boolean> {
  const operation = answerDraftSavePromise;
  if (!operation) return answerDraftSaveError.value === null;
  const outcome = await operation;
  if (answerDraftSavePromise && answerDraftSavePromise !== operation) return flushAnswerDraft();
  return outcome.status !== 'failed' && answerDraftSaveError.value === null;
}

function retryAnswerDraft(): void {
  if (pendingAnswerDraft.value) onAnswerDraft(pendingAnswerDraft.value);
}

async function commitGrade(payload: GradeCommitPayload): Promise<void> {
  if (commitBusy.value) return;
  const part: QuestionPart | undefined = current.value?.part;
  if (!part || part.id !== payload.partId) return;
  const interactionId = current.value?.item.learningInteractionId;
  commitBusy.value = true;
  commitError.value = null;
  try {
    const manual = payload.manualGrading ?? pendingGrading.value ?? undefined;
    const record = await practice.recordGraded({
      part,
      result: payload.result,
      submission: payload.submission,
      ...(hintLevel.value > 0 ? { hintLevel: hintLevel.value as 1 | 2 | 3 } : {}),
      ...(manual ? { manualGrading: manual } : {}),
    });
    if (current.value?.item.learningInteractionId !== interactionId) return;
    firstAttemptId.value = record?.clientAttemptId ?? null;
    if (record && JSON.stringify(record.result) !== JSON.stringify(payload.result)) {
      playerCommand.value = {
        id: ++playerCommandId,
        type: 'restore-review',
        result: record.result,
        ...(record.pendingSubmission ? { submission: record.pendingSubmission } : {}),
        ...(!record.pendingSubmission ? { submissionUnavailable: true } : {}),
      };
    }
    pendingGrading.value = null;
    pendingGradingSaveSequence += 1;
    pendingGradingSaveBusy.value = false;
    pendingGradingSaveError.value = null;
    pendingGradeCommit.value = null;
    pendingSelfAssessmentDraft.value = null;
    selfAssessmentDraftError.value = null;
    correctionDraftSaveSequence += 1;
    correctionDraftSaveBusy.value = false;
    correctionDraftError.value = null;
    pendingCorrectionDraft.value = null;
    answerDraftSaveSequence += 1;
    answerDraftSavePromise = undefined;
    answerDraftSaveBusy.value = false;
    answerDraftSaveError.value = null;
    pendingAnswerDraft.value = null;
    selfAssessmentDraftDurable.value = true;
  } catch {
    if (current.value?.item.learningInteractionId === interactionId) {
      commitError.value = 'Der Versuch wurde nicht gespeichert.';
    }
  } finally {
    commitBusy.value = false;
  }
}

async function onGraded(payload: GradeCommitPayload): Promise<void> {
  pendingGradeCommit.value = payload;
  await commitGrade(payload);
}

async function commitCorrection(payload: CorrectionCommitPayload): Promise<void> {
  if (commitBusy.value) return;
  if (current.value?.part.id !== payload.partId) return;
  const attemptId = firstAttemptId.value;
  if (!attemptId) return;
  const interactionId = current.value?.item.learningInteractionId;
  commitBusy.value = true;
  commitError.value = null;
  try {
    const durable = await practice.recordCorrection(attemptId, payload.partId, payload.result);
    if (current.value?.item.learningInteractionId !== interactionId) return;
    correctionOutcome.value = durable?.correctionOutcome ?? null;
    pendingCorrectionCommit.value = null;
    correctionDraftSaveSequence += 1;
    correctionDraftSaveBusy.value = false;
    correctionDraftError.value = null;
    pendingCorrectionDraft.value = null;
  } catch {
    if (current.value?.item.learningInteractionId === interactionId) {
      commitError.value = 'Die Korrektur wurde nicht gespeichert.';
    }
  } finally {
    commitBusy.value = false;
  }
}

async function onCorrected(payload: CorrectionCommitPayload): Promise<void> {
  pendingCorrectionCommit.value = payload;
  await commitCorrection(payload);
}

/* Double-click / accidental second-tap protection: after „Prüfen" flips the
 * phase synchronously, the same button instantly becomes „Weiter →" — a fast
 * second click would skip the feedback entirely. Ignore repeated activations
 * for a short window after every phase-changing click. */
let lastPrimaryAt = 0;
const PRIMARY_COOLDOWN_MS = 500;

async function advanceAfterReview(): Promise<void> {
  if (commitBusy.value) return;
  commitBusy.value = true;
  commitError.value = null;
  try {
    await practice.completeReviewAndNext();
  } catch {
    commitError.value = 'Der Programmstand wurde nicht gespeichert.';
  } finally {
    commitBusy.value = false;
  }
}

function primaryAction(): void {
  const now = Date.now();
  if (now - lastPrimaryAt < PRIMARY_COOLDOWN_MS) return;
  lastPrimaryAt = now;
  if (pendingGradingSaveError.value && pendingGrading.value) {
    void persistPendingGrading(pendingGrading.value);
    return;
  }
  if (correctionDraftError.value && pendingCorrectionDraft.value) {
    void onCorrectionDraft(pendingCorrectionDraft.value);
    return;
  }
  if (answerDraftSaveError.value && pendingAnswerDraft.value) {
    retryAnswerDraft();
    return;
  }
  switch (playerState.value.phase) {
    case 'answering':
      playerCommand.value = { id: ++playerCommandId, type: 'submit' };
      break;
    case 'self-assessing':
      if (selfAssessmentDraftError.value) retrySelfAssessmentDraft();
      else playerCommand.value = { id: ++playerCommandId, type: 'confirm-self-assessment' };
      break;
    case 'reviewed':
      if (pendingGradeCommit.value) void commitGrade(pendingGradeCommit.value);
      else if (pendingCorrectionCommit.value) void commitCorrection(pendingCorrectionCommit.value);
      else if (pendingOverrideGrading.value) void commitGradingOverride(pendingOverrideGrading.value);
      else void advanceAfterReview();
      break;
  }
}

const primaryLabel = computed(() => {
  if (commitBusy.value) return 'Speichert …';
  if (pendingGradingSaveBusy.value) return 'Speichert …';
  if (correctionDraftSaveBusy.value) return 'Speichert …';
  if (answerDraftSaveBusy.value) return 'Speichert …';
  if (pendingGradingSaveError.value) return 'Speichern wiederholen';
  if (correctionDraftError.value) return 'Speichern wiederholen';
  if (answerDraftSaveError.value) return 'Speichern wiederholen';
  if (selfAssessmentDraftError.value) return 'Speichern wiederholen';
  if (playerState.value.phase === 'self-assessing' && !selfAssessmentDraftDurable.value) return 'Speichert …';
  if (commitError.value) return 'Speichern wiederholen';
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
    if (commitBusy.value) return true;
    if (pendingGradingSaveBusy.value) return true;
    if (correctionDraftSaveBusy.value) return true;
    if (answerDraftSaveBusy.value) return true;
    if (pendingGradingSaveError.value) return false;
    if (correctionDraftError.value) return false;
    if (answerDraftSaveError.value) return false;
    if (playerState.value.phase === 'answering') return !playerState.value.canSubmit;
    if (playerState.value.phase === 'self-assessing') {
      if (selfAssessmentDraftError.value) return false;
      if (!selfAssessmentDraftDurable.value) return true;
      const self = playerState.value.selfAssessment;
      return self?.selectedPoints == null || self.grading == null;
    }
    return false;
  },
);

/* --- one learning loop: hint -> diagnosis -> correction ------------------- */
const ai = useAiStore();
const learningLoading = ref(false);
const learningError = ref<string | null>(null);
const learningResponse = ref<AiExplainResult | null>(null);
const authoredHint = ref<RichText | null>(null);
const learningUsesAi = ref(false);
const learningPanel = ref<{ focus: () => void } | null>(null);
let learningInvoker: HTMLElement | null = null;
const pendingHintLevel = ref<1 | 2 | 3 | null>(null);
const learningRenewGeneration = ref<number | null>(null);
const hintLevel = ref<0 | 1 | 2 | 3>(0);
const firstAttemptId = ref<string | null>(null);
const correctionOutcome = ref<GradeResult['verdict'] | null>(null);
let learningController: AbortController | undefined;

const firstResult = computed(() => playerState.value.firstResult ?? playerState.value.result);
const firstNeedsCorrection = computed(() =>
  firstResult.value != null && firstResult.value.verdict !== 'correct',
);
const bankHints = computed(() => current.value?.part.learning?.hints ?? []);
const aiLearningAllowed = computed(() =>
  current.value != null
  && practice.sessionIdentityDurable
  && ai.canLearn(current.value.question, current.value.part),
);
const learningStage = computed<'hint' | 'diagnosis' | 'correction'>(() => {
  if (playerState.value.attemptPhase === 'correction' || correctionOutcome.value) return 'correction';
  return firstResult.value ? 'diagnosis' : 'hint';
});
const learningAvailable = computed(() => {
  if (commitBusy.value || commitError.value) return false;
  if (playerState.value.phase === 'self-assessing') return false;
  if (learningResponse.value) return true;
  if (learningStage.value === 'hint' && authoredHint.value) return true;
  if (learningStage.value === 'hint') {
    return bankHints.value.length > 0 || (aiLearningAllowed.value && ai.canHint);
  }
  return firstNeedsCorrection.value;
});
const learningMarkdown = computed(() =>
  (learningResponse.value?.mode === 'hint' ? learningResponse.value.hint.markdown : undefined)
    ?? learningResponse.value?.markdown,
);
const learningNextAction = computed(() =>
  (learningResponse.value?.mode === 'hint' ? learningResponse.value.hint.nextAction : undefined)
    ?? (hintLevel.value > 0 ? 'Versuche jetzt den nächsten eigenen Schritt.' : undefined),
);
const canRequestHint = computed(() =>
  hintLevel.value < 3
  && (bankHints.value.some((hint) => hint.level > hintLevel.value)
    || (aiLearningAllowed.value && ai.canHint)),
);

function requestIdentity(
  mode: 'hint' | 'diagnosis' | 'assess',
): AiRequestContext | undefined {
  const interactionId = current.value?.item.learningInteractionId;
  const taskVersion = ai.capabilities?.taskVersions?.[mode];
  if (!practice.sessionIdentityDurable || !interactionId || !taskVersion || !practice.contentId) return undefined;
  const attemptPhase = playerState.value.attemptPhase;
  return {
    interactionId,
    taskVersion,
    contentSource: practice.contentSource,
    contentId: practice.contentId,
    attemptPhase,
  };
}

async function requestHint(options: { newRequest?: boolean; expectedGeneration?: number } = {}): Promise<void> {
  const part = current.value;
  if (!part || learningLoading.value || hintLevel.value >= 3) return;
  const nextAuthored = [...bankHints.value]
    .sort((left, right) => left.level - right.level)
    .find((hint) => hint.level > hintLevel.value);
  const level = (!aiLearningAllowed.value || !ai.canHint) && nextAuthored
    ? nextAuthored.level
    : pendingHintLevel.value
      ?? (Math.min(3, hintLevel.value + 1) as 1 | 2 | 3);
  const bankHint = bankHints.value.find((hint) => hint.level === level);
  learningError.value = null;
  if (bankHint) {
    pendingHintLevel.value = null;
    authoredHint.value = bankHint.content;
    learningResponse.value = null;
    learningUsesAi.value = false;
    hintLevel.value = level;
    pendingHintLevel.value = null;
    await practice.recordHintLevel(part.part.id, level).catch(() => undefined);
    return;
  }
  if (!aiLearningAllowed.value || !ai.canHint) {
    learningError.value = navigator.onLine
      ? 'Für diese Stufe ist kein Hinweis verfügbar.'
      : 'Offline ist nur der gespeicherte Hinweis verfügbar.';
    return;
  }
  const identity = requestIdentity('hint');
  if (!identity) return;
  pendingHintLevel.value = level;
  await runLearningRequest({
    mode: 'hint',
    hintLevel: level,
    submitted: '',
    identity,
  }, options);
}

async function requestDiagnosis(options: { newRequest?: boolean; expectedGeneration?: number } = {}): Promise<void> {
  const part = current.value;
  const result = firstResult.value;
  if (
    !part
    || !result
    || !firstNeedsCorrection.value
    || learningLoading.value
    || !playerState.value.submittedText.trim()
  ) return;
  if (!aiLearningAllowed.value || !ai.canDiagnose) return;
  const identity = requestIdentity('diagnosis');
  if (!identity) return;
  await runLearningRequest({
    mode: 'diagnosis',
    submitted: playerState.value.submittedText,
    result,
    identity,
  }, options);
}

async function runLearningRequest(input: {
  mode: 'hint' | 'diagnosis';
  submitted: string;
  result?: GradeResult;
  hintLevel?: 1 | 2 | 3;
  identity?: AiRequestContext;
}, options: { newRequest?: boolean; expectedGeneration?: number } = {}): Promise<void> {
  const part = current.value;
  if (!part || learningLoading.value) return;
  const partId = part.part.id;
  const userId = auth.session?.user.id;
  const controller = new AbortController();
  learningController?.abort();
  learningController = controller;
  learningLoading.value = true;
  learningUsesAi.value = true;
  learningError.value = null;
  learningRenewGeneration.value = null;
  authoredHint.value = null;
  try {
    const requestInput = {
      question: part.question,
      part: part.part,
      ...input,
    };
    const answer = await ai.explain(requestInput, controller.signal, options);
    if (
      controller.signal.aborted
      || current.value?.part.id !== partId
      || auth.session?.user.id !== userId
    ) return;
    learningResponse.value = answer;
    const locator = ai.explainCacheLocator(requestInput, answer);
    if (locator) {
      const replayable = await ai.replayExplain(locator, part.part).catch(() => undefined);
      if (replayable) {
        await practice.recordAiHelp(
          partId,
          locator,
          answer.mode === 'hint' ? input.hintLevel : undefined,
        ).catch(() => undefined);
      }
    }
    if (answer.mode === 'hint' && input.hintLevel) {
      hintLevel.value = input.hintLevel;
      pendingHintLevel.value = null;
    }
    const eventId = firstAttemptId.value;
    if (answer.mode === 'diagnosis' && eventId) {
      await practice.recordDiagnosis(eventId, partId, answer.diagnosis.errorCode);
    }
  } catch (error) {
    if (
      !controller.signal.aborted
      && current.value?.part.id === partId
      && auth.session?.user.id === userId
    ) learningError.value = explainMessage(error);
    if (
      (error as { code?: unknown })?.code === 'AI_REQUEST_ALREADY_COMPLETED'
      && Number.isSafeInteger((error as { paidRequestGeneration?: unknown }).paidRequestGeneration)
    ) {
      learningRenewGeneration.value = (error as { paidRequestGeneration: number }).paidRequestGeneration;
    }
  } finally {
    if (learningController === controller) {
      learningController = undefined;
      learningLoading.value = false;
    }
  }
}

function renewLearning(): void {
  const expectedGeneration = learningRenewGeneration.value;
  if (expectedGeneration == null) return;
  const options = { newRequest: true, expectedGeneration } as const;
  if (learningStage.value === 'hint') void requestHint(options);
  else void requestDiagnosis(options);
}

async function startCorrection(): Promise<void> {
  if (
    commitBusy.value
    || commitError.value
    || !firstAttemptId.value
    || !firstNeedsCorrection.value
    || playerState.value.attemptPhase !== 'first'
  ) return;
  playerCommand.value = { id: ++playerCommandId, type: 'start-correction' };
  solutionDetent.value = 'default';
  await nextTick();
  await nextTick();
  document.querySelector<HTMLElement>(
    '.q-part__control input:not([disabled]), .q-part__control textarea:not([disabled]), .q-part__control select:not([disabled]), .q-part__control [contenteditable="true"], .q-part__control button:not([disabled])',
  )?.focus();
}

async function toggleLearning(): Promise<void> {
  const opening = solutionDetent.value === 'collapsed';
  if (opening && document.activeElement instanceof HTMLElement) learningInvoker = document.activeElement;
  solutionDetent.value = opening ? 'default' : 'collapsed';
  if (opening) {
    await nextTick();
    learningPanel.value?.focus();
  } else {
    learningInvoker?.focus();
  }
}

function dismissLearning(): void {
  solutionDetent.value = 'collapsed';
  void nextTick(() => learningInvoker?.focus());
}

function closeLockedSession(): void {
  void router.replace('/');
}

/* --- AI assistance for self-assessment ------------------------------------
 * A suggestion, never a commit. The user still presses „Bewertung übernehmen".
 */
const assistLoading = ref(false);
const assistError = ref<string | null>(null);
const assistResult = ref<AiAssessResult | null>(null);
const assistRenewGeneration = ref<number | null>(null);
let assistController: AbortController | undefined;

const showAssist = computed(
  () => playerState.value.phase === 'self-assessing'
    && playerState.value.selfAssessment?.selectedPoints != null
    && playerState.value.selfAssessment?.grading != null
    && current.value != null
    && practice.sessionIdentityDurable
    && selfAssessmentDraftDurable.value
    && (assistResult.value != null || ai.canAssess(current.value.part, current.value.question)),
);

const rubricLabels = computed(() => {
  const scoring = current.value?.part.scoring;
  return scoring?.mode === 'rubric' ? scoring.criteria.map((c) => c.desc) : [];
});

const assist = computed(() => ({
  criteria: assistResult.value?.criteria,
  overall: assistResult.value?.overall,
  source: assistResult.value?.source,
  advisoryOnly: assistResult.value?.advisoryOnly,
  model: assistResult.value?.model,
  loading: assistLoading.value,
  error: assistError.value ?? undefined,
}));

/** Abort and reset when the part or signed-in identity changes. */
watch(
  [() => current.value?.part.id, () => auth.session?.user.id],
  () => {
    const restored = practice.currentReview;
    assistController?.abort();
    assistController = undefined;
    learningController?.abort();
    learningController = undefined;
    assistResult.value = null;
    assistError.value = null;
    assistLoading.value = false;
    assistRenewGeneration.value = null;
    learningResponse.value = null;
    authoredHint.value = null;
    learningUsesAi.value = false;
    pendingHintLevel.value = null;
    learningError.value = null;
    learningLoading.value = false;
    hintLevel.value = restored?.hintLevel ?? current.value?.item.deliveredHintLevel ?? 0;
    firstAttemptId.value = restored?.clientAttemptId ?? null;
    correctionOutcome.value = restored?.correctionOutcome ?? null;
    commitError.value = null;
    pendingGradeCommit.value = null;
    pendingCorrectionCommit.value = null;
    pendingOverrideGrading.value = null;
    pendingGrading.value = practice.currentPendingGrading;
    pendingGradingSaveSequence += 1;
    pendingGradingSaveBusy.value = false;
    pendingGradingSaveError.value = null;
    selfAssessmentDraftDurable.value = Boolean(practice.currentSelfAssessmentDraft);
    pendingSelfAssessmentDraft.value = null;
    selfAssessmentDraftError.value = null;
    correctionDraftSaveSequence += 1;
    correctionDraftSaveBusy.value = false;
    correctionDraftError.value = null;
    pendingCorrectionDraft.value = null;
    answerDraftSaveSequence += 1;
    answerDraftSavePromise = undefined;
    answerDraftSaveBusy.value = false;
    answerDraftSaveError.value = null;
    pendingAnswerDraft.value = null;
  },
  { immediate: true },
);

let cachedAssessmentReplay = 0;
watch(
  [() => playerState.value.phase, () => playerState.value.attemptPhase],
  ([phase, attemptPhase], [previousPhase, previousAttemptPhase]) => {
    if (
      attemptPhase === previousAttemptPhase
      && !(previousPhase === 'self-assessing' && phase !== 'self-assessing')
    ) return;
    cachedAssessmentReplay += 1;
    assistController?.abort();
    assistController = undefined;
    assistResult.value = null;
    assistError.value = null;
    assistLoading.value = false;
    assistRenewGeneration.value = null;
  },
);
watch(
  [
    () => current.value?.item.cachedAiAssessment?.cacheKey,
    () => current.value?.part.id,
    () => playerState.value.phase,
    () => playerState.value.attemptPhase,
    () => playerState.value.submittedText,
    () => playerState.value.selfAssessment?.selectedPoints,
    () => auth.session?.user.id,
  ],
  async () => {
    const marker = current.value?.item.cachedAiAssessment;
    const part = current.value;
    const self = playerState.value.selfAssessment;
    const userId = auth.session?.user.id;
    const replay = ++cachedAssessmentReplay;
    if (
      !marker
      || !part
      || !self
      || marker.partId !== part.part.id
      || marker.attemptPhase !== playerState.value.attemptPhase
      || playerState.value.phase !== 'self-assessing'
      || self.selectedPoints == null
      || self.grading == null
      || assistResult.value
    ) return;
    const input = {
      question: part.question,
      part: part.part,
      submitted: playerState.value.submittedText,
      maxPoints: self.maxPoints,
      scoreOptions: self.scoreOptions.map((option) => option.points),
    };
    const cached = await ai.replayAssess(marker, input).catch(() => undefined);
    if (
      !cached
      || replay !== cachedAssessmentReplay
      || current.value?.part.id !== part.part.id
      || auth.session?.user.id !== userId
      || playerState.value.phase !== 'self-assessing'
      || marker.attemptPhase !== playerState.value.attemptPhase
    ) return;
    assistResult.value = cached;
  },
  { immediate: true },
);

let cachedHelpReplay = 0;
const cachedHelpForStage = computed(() => {
  const item = current.value?.item;
  if (!item) return undefined;
  if (learningStage.value === 'hint') {
    return item.cachedAiHint
      ?? (item.cachedAiHelp?.mode === 'hint' ? item.cachedAiHelp : undefined);
  }
  return item.cachedAiDiagnosis
    ?? (item.cachedAiHelp?.mode === 'diagnosis' ? item.cachedAiHelp : undefined);
});
watch(learningStage, (stage, previousStage) => {
  if (stage !== previousStage) {
    cachedHelpReplay += 1;
    learningController?.abort();
    learningController = undefined;
    learningLoading.value = false;
    learningError.value = null;
    learningRenewGeneration.value = null;
    pendingHintLevel.value = null;
  }
  if (stage !== 'hint') authoredHint.value = null;
  const mode = learningResponse.value?.mode;
  if ((mode === 'hint' && stage !== 'hint') || (mode === 'diagnosis' && stage === 'hint')) {
    learningResponse.value = null;
    learningUsesAi.value = false;
  }
});
watch(
  [
    () => cachedHelpForStage.value?.cacheKey,
    () => current.value?.part.id,
    () => auth.session?.user.id,
    learningStage,
  ],
  async () => {
    const marker = cachedHelpForStage.value;
    const partId = current.value?.part.id;
    const userId = auth.session?.user.id;
    const replay = ++cachedHelpReplay;
    if (!marker || !partId || marker.partId !== partId || learningResponse.value) return;
    if (
      (marker.mode === 'hint' && learningStage.value !== 'hint')
      || (marker.mode === 'diagnosis' && learningStage.value === 'hint')
    ) return;
    const cached = await ai.replayExplain(marker, current.value!.part).catch(() => undefined);
    if (
      !cached
      || replay !== cachedHelpReplay
      || current.value?.part.id !== partId
      || auth.session?.user.id !== userId
    ) return;
    learningResponse.value = cached;
    learningUsesAi.value = true;
    if (cached.mode === 'hint') {
      hintLevel.value = Math.max(hintLevel.value, cached.hint.level) as 1 | 2 | 3;
    }
  },
  { immediate: true },
);

async function askForAssessment(options: { newRequest?: boolean; expectedGeneration?: number } = {}): Promise<void> {
  const part = current.value;
  const self = playerState.value.selfAssessment;
  if (!part || !self || assistLoading.value) return;
  const partId = part.part.id;
  const userId = auth.session?.user.id;
  if (self.selectedPoints == null || self.grading == null) return;
  const identity = requestIdentity('assess');
  const controller = new AbortController();
  assistController?.abort();
  assistController = controller;
  assistLoading.value = true;
  assistError.value = null;
  assistRenewGeneration.value = null;
  try {
    const requestInput = {
      question: part.question,
      part: part.part,
      submitted: playerState.value.submittedText,
      maxPoints: self.maxPoints,
      // Non-rubric parts are judged against the values the part allows, so the
      // model can never return a score this part cannot represent.
      scoreOptions: self.scoreOptions.map((o) => o.points),
      ...(identity ? { identity } : {}),
    };
    const answer = await ai.assess(requestInput, controller.signal, options);
    if (
      controller.signal.aborted ||
      current.value?.part.id !== partId ||
      auth.session?.user.id !== userId ||
      playerState.value.phase !== 'self-assessing'
    ) return;
    assistResult.value = answer;
    if (answer) {
      const locator = ai.assessCacheLocator(requestInput, answer);
      if (locator) {
        const replayable = await ai.replayAssess(locator, requestInput).catch(() => undefined);
        if (replayable) {
          await practice.recordCachedAiAssessment(partId, locator).catch(() => undefined);
        }
      }
    }
  } catch (e) {
    if (
      !controller.signal.aborted &&
      current.value?.part.id === partId &&
      auth.session?.user.id === userId
    ) {
      assistError.value = explainMessage(e);
      if (
        (e as { code?: unknown })?.code === 'AI_REQUEST_ALREADY_COMPLETED'
        && Number.isSafeInteger((e as { paidRequestGeneration?: unknown }).paidRequestGeneration)
      ) {
        assistRenewGeneration.value = (e as { paidRequestGeneration: number }).paidRequestGeneration;
      }
    }
  } finally {
    if (assistController === controller) {
      assistController = undefined;
      assistLoading.value = false;
    }
  }
}

function renewAssessment(): void {
  const expectedGeneration = assistRenewGeneration.value;
  if (expectedGeneration == null) return;
  void askForAssessment({ newRequest: true, expectedGeneration });
}

/** Turn an API error code into something a student can act on. */
function explainMessage(e: unknown): string {
  const code = (e as { code?: string })?.code;
  switch (code) {
    case 'AI_NO_CREDENTIAL':
      return 'Kein KI-Schlüssel hinterlegt — unter Optionen einrichten.';
    case 'AI_NOT_ENTITLED':
      return 'Diese KI-Quelle ist für dein Konto nicht freigeschaltet — bitte Optionen prüfen.';
    case 'AI_POOL_UNAVAILABLE':
      return 'Das bereitgestellte KI-Kontingent ist gerade nicht verfügbar.';
    case 'AI_QUOTA_EXCEEDED':
    case 'AI_PROVIDER_QUOTA':
      return 'Dein KI-Kontingent für diesen Monat ist aufgebraucht.';
    case 'AI_KEY_REJECTED':
      return 'Der KI-Anbieter hat den Schlüssel abgelehnt — bitte unter Optionen prüfen.';
    case 'AI_CREDENTIAL_CHANGED':
      return 'Der KI-Schlüssel wurde geändert — bitte noch einmal versuchen.';
    case 'AI_RATE_LIMITED':
      return 'Zu viele Anfragen — bitte kurz warten.';
    case 'AI_TIMEOUT':
    case 'AI_UNREACHABLE':
      return 'Die KI war nicht erreichbar. Nochmal versuchen?';
    case 'AI_REQUEST_IN_PROGRESS':
      return 'Die vorige Anfrage läuft noch. Bitte kurz warten und mit derselben Aktion erneut prüfen.';
    case 'AI_REQUEST_ALREADY_COMPLETED':
      return 'Die Antwort wurde bereits erstellt, kam nach dem Verbindungsabbruch aber nicht zurück. Es wird nicht automatisch erneut bezahlt.';
    case 'AI_REQUEST_ID_REUSED':
      return 'Die Aufgabe oder KI-Einstellung hat sich geändert. Bitte die Hilfe neu öffnen.';
    case 'AI_TASK_VERSION_MISMATCH':
      return 'Client und Server verwenden unterschiedliche KI-Versionen. Bitte QED2 aktualisieren.';
    default:
      return 'Die KI-Hilfe konnte nicht erzeugt werden.';
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
      verdictAnchor.value?.scrollIntoView({
        block: 'nearest',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
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

const gradingReviewReplaceable = computed(() => {
  if (playerState.value.attemptPhase === 'correction') return false;
  const review = practice.currentReview;
  return playerState.value.phase === 'answering'
    || review === undefined
    || review.gradingBaseCaptured === true;
});
const gradingOverrideDisabled = computed(() =>
  commitBusy.value
  || commitError.value !== null
  || pendingGradeCommit.value !== null
  || pendingCorrectionCommit.value !== null
  || !gradingReviewReplaceable.value,
);

async function commitGradingOverride(grading: Grading): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId || commitBusy.value || !gradingReviewReplaceable.value) return;
  const interactionId = current.value?.item.learningInteractionId;
  pendingOverrideGrading.value = grading;
  commitBusy.value = true;
  commitError.value = null;
  try {
    await practice.overrideGrading(partId, grading);
    if (current.value?.item.learningInteractionId !== interactionId) return;
    pendingOverrideGrading.value = null;
  } catch {
    if (current.value?.item.learningInteractionId === interactionId) {
      commitError.value = 'Die Bewertung wurde nicht gespeichert.';
    }
  } finally {
    commitBusy.value = false;
  }
}

async function onGradingSelect(grading: Grading): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId) return;
  if (
    playerState.value.phase === 'answering'
    && playerState.value.attemptPhase === 'first'
    && practice.currentReview === undefined
  ) {
    pendingGrading.value = grading;
    await persistPendingGrading(grading);
    return;
  }
  if (gradingOverrideDisabled.value) return;
  pendingGrading.value = null;
  await commitGradingOverride(grading);
}

async function persistPendingGrading(grading: Grading): Promise<void> {
  const partId = current.value?.part.id;
  if (!partId) return;
  const sequence = ++pendingGradingSaveSequence;
  pendingGradingSaveBusy.value = true;
  pendingGradingSaveError.value = null;
  const saved = await practice.savePendingGrading(partId, grading).catch(() => false);
  if (sequence === pendingGradingSaveSequence && current.value?.part.id === partId) {
    pendingGradingSaveBusy.value = false;
    pendingGradingSaveError.value = saved
      ? null
      : 'Die Bewertung konnte nicht lokal gespeichert werden.';
  }
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
  const fixedSource = q.coreSource === 'local' || q.coreSource === 'remote'
    ? q.coreSource
    : undefined;
  const expectedContentId = typeof q.contentId === 'string' && q.contentId.length > 0
    ? q.contentId
    : undefined;
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
  if (fixedSource) await practice.startQuestions(questionIds, fixedSource, expectedContentId);
  else await practice.startQuestions(questionIds);
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
  if (!practice.sessionAccessible) {
    void router.replace(returnTarget());
    return;
  }
  if (answerDraftSaveBusy.value && !(await flushAnswerDraft())) return;
  if (
    commitBusy.value
    || commitError.value
    || pendingGradingSaveBusy.value
    || pendingGradingSaveError.value
    || correctionDraftSaveBusy.value
    || correctionDraftError.value
    || answerDraftSaveError.value
    || selfAssessmentDraftError.value
    || (playerState.value.phase === 'self-assessing' && !selfAssessmentDraftDurable.value)
  ) return;
  // Everything that must be attempted before leaving goes INSIDE the race:
  // finishSession persists (fast, local) then syncs (arbitrary network), and
  // a storage write can hang or reject too. A dead-but-accepting server used
  // to leave the user staring at a screen that did nothing; the outbox and
  // the archive are durable, so leaving early loses nothing.
  await Promise.race([
    (async () => {
      await practice.finishSession();
    })().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, EXIT_SYNC_GRACE_MS)),
  ]);
  void router.replace(returnTarget());
}

function exit(): void {
  if (hasUndurableWork.value) return;
  if (!exitArmed.value) {
    exitArmed.value = true;
    return;
  }
  void exitNow();
}

function onDocumentPointerDown(ev: PointerEvent): void {
  if (!exitArmed.value) return;
  const target = ev.target;
  if (target instanceof Element && target.closest('[data-practice-exit]')) return;
  exitArmed.value = false;
}

function onKeydown(ev: KeyboardEvent): void {
  if (
    ev.defaultPrevented
    || ev.key !== 'ArrowRight'
    || ev.repeat
    || ev.isComposing
    || ev.altKey
    || ev.ctrlKey
    || ev.metaKey
    || ev.shiftKey
  ) return;
  // Never steal arrows from native controls (selects, menus, text fields) —
  // they need them for their own keyboard navigation.
  const target = ev.target as HTMLElement | null;
  if (target?.closest([
    'input',
    'select',
    'textarea',
    'button',
    'a',
    'summary',
    'details',
    '[contenteditable="true"]',
    '[role=dialog]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
  ].join(', ')))
    return;
  if (
    playerState.value.phase === 'reviewed'
    && practice.phase === 'running'
    && practice.sessionAccessible
    && !commitBusy.value
    && !commitError.value
  ) {
    ev.preventDefault();
    void advanceAfterReview();
  }
}

const hasUndurableWork = computed(() =>
  commitBusy.value
  || pendingGradingSaveBusy.value
  || pendingGradingSaveError.value !== null
  || correctionDraftSaveBusy.value
  || correctionDraftError.value !== null
  || answerDraftSaveBusy.value
  || answerDraftSaveError.value !== null
  || commitError.value !== null
  || selfAssessmentDraftError.value !== null
  || (playerState.value.phase === 'self-assessing' && !selfAssessmentDraftDurable.value),
);
let allowRouteLeave = false;

onBeforeRouteLeave(async () => {
  if (allowRouteLeave) return true;
  if (answerDraftSaveBusy.value && !(await flushAnswerDraft())) return false;
  return !hasUndurableWork.value;
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUndurableWork.value) return;
  event.preventDefault();
  event.returnValue = '';
}

function abandonUndurableAndExit(): void {
  if (commitBusy.value) return;
  allowRouteLeave = true;
  pendingGradeCommit.value = null;
  pendingCorrectionCommit.value = null;
  pendingOverrideGrading.value = null;
  pendingSelfAssessmentDraft.value = null;
  pendingCorrectionDraft.value = null;
  pendingAnswerDraft.value = null;
  commitError.value = null;
  selfAssessmentDraftError.value = null;
  pendingGradingSaveError.value = null;
  correctionDraftError.value = null;
  answerDraftSaveError.value = null;
  void router.replace(returnTarget());
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
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onBeforeUnmount(() => {
  assistController?.abort();
  learningController?.abort();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('resize', measureTopbar);
  topbarObserver?.disconnect();
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  practice.suspendContentPin();
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
const summaryAction = computed(() => {
  if (summaryStats.value.corrections.unresolved > 0) {
    return 'Als Nächstes: eine ähnliche Aufgabe gezielt üben.';
  }
  if (summaryStats.value.corrections.eligible > 0) return 'Als Nächstes: eine ähnliche Aufgabe festigen.';
  return 'Als Nächstes: eine ähnliche Aufgabe lösen.';
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
const desktopShell = ports.shell.capabilities.desktop;
const bankSourceIsLocal = computed(
  () => desktopShell && practice.contentSource === 'local',
);
const bankSourceName = computed(() => {
  if (!desktopShell) return 'Remote-Core';
  return bankSourceIsLocal.value ? 'Lokale Bank' : 'Remote-Core';
});
const bankSourceText = computed(() => {
  const revision = practice.contentId ? shortCommit(practice.contentId) : 'Version wird geprüft';
  const archive = practice.contentMode === 'revision' ? 'Archiv ' : '';
  return `${bankSourceName.value} · ${archive}${revision}`;
});
const bankSourceA11yText = computed(() => {
  const revision = practice.contentId
    ? `Revision ${practice.contentId}`
    : 'Revision wird geprüft';
  const archive = practice.contentMode === 'revision' ? 'Archiv. ' : '';
  return `${bankSourceName.value}. ${archive}${revision}`;
});
const bankSourceTitle = computed(() => {
  if (!practice.contentId) return undefined;
  const archive = practice.contentMode === 'revision' ? ' · Archiv' : '';
  return `${bankSourceName.value}${archive} · ${practice.contentId}`;
});

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

async function jumpToSessionItem(index: number): Promise<void> {
  if (
    commitBusy.value
    || commitError.value
    || pendingGradingSaveBusy.value
    || pendingGradingSaveError.value
    || correctionDraftSaveBusy.value
    || correctionDraftError.value
    || answerDraftSaveError.value
    || selfAssessmentDraftError.value
    || (playerState.value.phase === 'self-assessing' && !selfAssessmentDraftDurable.value)
  ) return;
  if (answerDraftSaveBusy.value && !(await flushAnswerDraft())) return;
  commitBusy.value = true;
  try {
    if (playerState.value.phase === 'reviewed') await practice.closeCurrentReview();
    practice.jumpTo(index);
    mobileRailOpen.value = false;
  } catch {
    commitError.value = 'Der Programmstand wurde nicht gespeichert.';
  } finally {
    commitBusy.value = false;
  }
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
      <QIconButton
        data-practice-exit
        class="practice__close"
        :class="{ 'practice__close--armed': exitArmed }"
        :aria-label="exitArmed ? 'Programm verlassen bestätigen' : 'Programm verlassen'"
        :title="exitArmed ? 'Erneut klicken, um das Programm zu verlassen' : 'Programm verlassen'"
        @click.stop="exit"
      />
      <div class="practice__progress">
        <div class="practice__progress-label">
          <template v-if="practice.phase === 'running' && practice.sessionAccessible">Aufgabe {{ practice.index + 1 }} von {{ practice.total }}</template>
          <template v-else-if="practice.phase === 'summary' && practice.sessionAccessible">Programm abgeschlossen</template>
          <template v-else>QED<span class="practice__logo-accent">2</span></template>
        </div>
        <SessionProgressBar
          :items="practice.sessionAccessible ? practice.items : []"
          :graded="practice.sessionAccessible ? progressGraded : []"
          :current-index="practice.index"
          :active="practice.phase === 'running' && practice.sessionAccessible"
        />
      </div>
      <button
        v-if="practice.phase === 'running' && practice.sessionAccessible && showProgramRail"
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
      <!-- A profile switch locks every user-specific surface, including a
           completed summary. The old snapshot remains untouched and becomes
           visible again only after switching back to its owning profile. -->
      <div
        v-if="!practice.sessionAccessible"
        key="account-locked"
        class="practice__center"
      >
        <div class="practice__error" role="alert">
          <div class="practice__error-title">Programm gehört zu einem anderen Konto</div>
          <div class="practice__error-text">
            Wechsle zum ursprünglichen Konto zurück, um genau hier weiterzumachen.
          </div>
          <QButton variant="secondary" @click="closeLockedSession">Schließen</QButton>
        </div>
      </div>

      <!-- loading -->
      <div v-else-if="practice.phase === 'loading'" key="loading" class="practice__center">
        <div class="practice__skeleton">
          <div class="practice__skeleton-bar" style="width: 40%" />
          <div class="practice__skeleton-bar" style="width: 90%" />
          <div class="practice__skeleton-bar" style="width: 75%" />
          <div class="practice__skeleton-bar" style="width: 85%" />
        </div>
        <div class="practice__loading-text">Aufgaben werden geladen …</div>
      </div>

      <!-- Legacy snapshots did not record a bank revision. They stay intact
           until the user explicitly accepts reopening those question ids
           against today's selected bank; no Core request happens before it. -->
      <div
        v-else-if="practice.phase === 'provenance-choice'"
        key="provenance-choice"
        class="practice__center"
      >
        <div class="practice__error" role="status" aria-live="polite">
          <h1 ref="provenanceHeading" class="practice__error-title" tabindex="-1">
            Aufgabenversion unbekannt
          </h1>
          <div class="practice__error-text">
            Dieses gespeicherte Programm stammt aus einer älteren QED2-Version und nennt
            keine Aufgabenbank. Es wird nicht automatisch mit neueren Aufgaben vermischt.
            Du kannst dieselben Aufgaben-IDs bewusst mit der aktuell gewählten Bank öffnen.
          </div>
          <div class="practice__actions-row">
            <QButton variant="secondary" @click="exitNow">Später</QButton>
            <QButton @click="practice.resumeWithCurrentContent()">
              Aktuelle Aufgabenbank verwenden
            </QButton>
          </div>
        </div>
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

            <p v-if="summaryStats.corrections.eligible > 0" class="practice__result-count">
              Korrektur {{ summaryStats.corrections.correct }} / {{ summaryStats.corrections.eligible }}
            </p>

            <p class="practice__result-action">{{ summaryAction }}</p>

            <p v-if="auth.isLoggedIn && syncNote" class="practice__result-sync">{{ syncNote }}</p>
          </section>

          <QButton class="practice__summary-cta" @click="exitNow">Zurück</QButton>
          <div
            class="practice__source-footer practice__source-footer--summary"
            :data-source="bankSourceIsLocal ? 'local' : 'remote'"
            :title="bankSourceTitle"
          >
            <HardDrive v-if="bankSourceIsLocal" :size="12" aria-hidden="true" />
            <Cloud v-else :size="12" aria-hidden="true" />
            <span aria-hidden="true">{{ bankSourceText }}</span>
            <span class="practice__visually-hidden">{{ bankSourceA11yText }}</span>
          </div>
        </div>
      </div>

      <!-- running -->
      <div v-else-if="practice.phase === 'running' && current" key="running" class="practice__running">
        <div class="practice__body">
          <div v-if="showProgramRail" class="practice__session-rail-shell">
            <PracticeSessionRail
              :items="railItems"
              :graded-count="gradedCount"
              :total="practice.total"
              @jump="jumpToSessionItem"
            />
            <div
              class="practice__source-footer"
              :data-source="bankSourceIsLocal ? 'local' : 'remote'"
              :title="bankSourceTitle"
            >
              <HardDrive v-if="bankSourceIsLocal" :size="12" aria-hidden="true" />
              <Cloud v-else :size="12" aria-hidden="true" />
              <span aria-hidden="true">{{ bankSourceText }}</span>
              <span class="practice__visually-hidden">{{ bankSourceA11yText }}</span>
            </div>
          </div>

          <PracticeSessionDrawer
            v-if="showProgramRail"
            :open="mobileRailOpen"
            :items="railItems"
            :graded-count="gradedCount"
            :total="practice.total"
            @close="mobileRailOpen = false"
            @jump="jumpToSessionItem"
          />

          <Teleport
            v-if="mobileSourceFooterReady && mobileRailOpen"
            to=".practice-session-drawer__panel"
          >
            <div
              class="practice__source-footer practice__source-footer--drawer"
              :data-source="bankSourceIsLocal ? 'local' : 'remote'"
              :title="bankSourceTitle"
            >
              <HardDrive v-if="bankSourceIsLocal" :size="12" aria-hidden="true" />
              <Cloud v-else :size="12" aria-hidden="true" />
              <span aria-hidden="true">{{ bankSourceText }}</span>
              <span class="practice__visually-hidden">{{ bankSourceA11yText }}</span>
            </div>
          </Teleport>

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
              :restored-first-result="practice.currentReview?.result"
              :restored-submission="practice.currentReview?.pendingSubmission"
              :restored-submission-unavailable="Boolean(
                practice.currentReview
                && !practice.currentReview.pendingSubmission
                && !practice.currentReview.correctionDraft
              )"
              :restored-correction-draft="practice.currentReview?.correctionDraft?.submission"
              :restored-draft="practice.currentSelfAssessmentDraft"
              :restored-answer-draft="practice.currentAnswerDraft"
              chromeless
              @graded="onGraded"
              @corrected="onCorrected"
              @state="onPlayerState"
              @draft="onPlayerDraft"
              @correction-draft="onCorrectionDraft"
              @answer-draft="onAnswerDraft"
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

            <div
              v-if="!showProgramRail"
              class="practice__source-footer practice__source-footer--inline"
              :data-source="bankSourceIsLocal ? 'local' : 'remote'"
              :title="bankSourceTitle"
            >
              <HardDrive v-if="bankSourceIsLocal" :size="12" aria-hidden="true" />
              <Cloud v-else :size="12" aria-hidden="true" />
              <span aria-hidden="true">{{ bankSourceText }}</span>
              <span class="practice__visually-hidden">{{ bankSourceA11yText }}</span>
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
          :grading-disabled="gradingOverrideDisabled"
          :primary-label="primaryLabel"
          :primary-disabled="primaryDisabled"
          :learning-available="learningAvailable"
          :solution-ready="playerState.phase !== 'self-assessing' || selfAssessmentDraftDurable"
          @assessment-update="onSelfAssessmentUpdate"
          @self-grading-select="onSelfGradingSelect"
          @grading-select="onGradingSelect"
          @primary="primaryAction"
          @learning-toggle="toggleLearning"
        >
          <!-- Offered only for a wrong or half-right answer, and only once the
               account can actually pay for it (see aiStore.canExplain). -->
          <!-- Only for parts the bank marked grader:'ai' with a rubric. -->
          <template v-if="showAssist" #assist>
            <AiAssessPanel
              :criteria="assist.criteria"
              :overall="assist.overall"
              :max-points="playerState.selfAssessment?.maxPoints"
              :labels="rubricLabels"
              :loading="assist.loading"
              :error="assist.error"
              :storage-warning="ai.cacheWarning ?? undefined"
              :can-renew="assistRenewGeneration != null"
              :advisory-only="assist.advisoryOnly"
              :model="assist.model"
              :source="assist.source"
              :student-criteria="playerState.selfAssessment?.assessment.criteriaMet"
              :student-points="playerState.selfAssessment?.selectedPoints ?? undefined"
              @ask="askForAssessment"
              @renew="renewAssessment"
            />
          </template>

          <!--
            All of the AI lives in the drawer. On a phone that is the only
            surface tall enough for a conversation, and splitting it between
            the drawer and the scrolling question meant the two halves of the
            same feature never appeared together.
          -->
          <template v-if="learningAvailable" #explain>
            <AiLearningPanel
              ref="learningPanel"
              :stage="learningStage"
              :hint-level="hintLevel || undefined"
              :markdown="learningMarkdown"
              :authored-hint="authoredHint ?? undefined"
              :next-action="learningNextAction"
              :diagnosis="learningResponse?.mode === 'diagnosis' ? learningResponse.diagnosis : undefined"
              :correction-outcome="correctionOutcome ?? undefined"
              :loading="learningLoading"
              :error="learningError ?? undefined"
              :storage-warning="ai.cacheWarning ?? undefined"
              :can-renew="learningRenewGeneration != null"
              :ai-generated="learningUsesAi"
              :can-request-hint="canRequestHint"
              :can-request-diagnosis="learningStage === 'diagnosis' && firstNeedsCorrection && !learningResponse && aiLearningAllowed && ai.canDiagnose && Boolean(playerState.submittedText.trim())"
              :can-correct="firstNeedsCorrection && playerState.attemptPhase === 'first'"
              :model="learningResponse?.model"
              :source="learningResponse?.source"
              @request-hint="requestHint"
              @request-diagnosis="requestDiagnosis"
              @renew="renewLearning"
              @correct="startCorrection"
              @dismiss="dismissLearning"
            />
          </template>
        </PracticeBottomBar>

        <div v-if="practice.warning" class="practice__warning" role="alert">{{ practice.warning }}</div>
        <div v-if="commitError || selfAssessmentDraftError || pendingGradingSaveError || correctionDraftError || answerDraftSaveError" class="practice__warning" role="alert">
          <span>{{ commitError ?? selfAssessmentDraftError ?? pendingGradingSaveError ?? correctionDraftError ?? answerDraftSaveError }}</span>
          <QButton
            v-if="!commitBusy"
            variant="secondary"
            size="sm"
            @click="abandonUndurableAndExit"
          >
            Ohne Speichern verlassen
          </QButton>
        </div>
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
  flex: 0 0 var(--q-icon-control-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  overflow: hidden;
  transition:
    width var(--q-transition-fast),
    min-width var(--q-transition-fast),
    flex-basis var(--q-transition-fast),
    background var(--q-transition-fast),
    color var(--q-transition-fast),
    opacity var(--q-transition-fast);
}
.practice__close--armed {
  width: 88px;
  min-width: 88px;
  flex-basis: 88px;
  background: var(--q-err-bg);
  color: var(--q-err);
}
.practice__close--armed::after {
  content: 'Beenden?';
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .practice__close--armed:hover {
    background: var(--q-err-bg);
  }
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
.practice__session-rail-shell {
  width: var(--practice-rail-width);
  height: calc(100vh - 56px);
  height: calc(100dvh - 56px);
  flex: none;
  position: sticky;
  top: 56px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px 10px 10px;
  overflow: hidden;
  background: var(--q-panel);
  border-right: 1px solid var(--q-border);
}
.practice__session-rail-shell :deep(.practice-rail) {
  width: 100%;
  height: auto;
  min-height: 0;
  flex: 1 1 auto;
  position: static;
  padding: 0;
  overflow-y: auto;
  background: transparent;
  border: 0;
}
.practice__source-footer {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 5px;
  min-width: 0;
  margin-top: 10px;
  padding: 10px 8px 1px;
  border-top: 1px solid var(--q-border-soft);
  color: var(--q-faint);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
}
.practice__source-footer > svg {
  flex: none;
}
.practice__source-footer > span[aria-hidden='true'] {
  overflow: hidden;
  text-overflow: ellipsis;
}
.practice__source-footer[data-source='local'] {
  color: var(--q-ok-ink);
}
.practice__source-footer--drawer {
  width: 100%;
  margin-top: auto;
  padding: 14px 8px 2px;
}
.practice__source-footer--inline,
.practice__source-footer--summary {
  width: max-content;
  max-width: 100%;
  margin-right: auto;
  margin-left: auto;
  padding-right: 8px;
  padding-left: 8px;
}
.practice__source-footer--inline {
  margin-top: 22px;
}
.practice__source-footer--summary {
  margin-top: 0;
}
.practice__visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.practice__body :deep(.practice-session-drawer__panel) {
  display: flex;
  flex-direction: column;
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
.practice__ai-panels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 4px;
}
.practice__ai-panels--active {
  grid-template-columns: minmax(0, 1fr);
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
  margin: 0 0 8px;
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
  .practice__session-rail-shell {
    display: none;
  }
  .practice__session-button {
    visibility: visible;
  }
}

@media (pointer: coarse) {
  /* 44px touch targets in the always-visible chrome (fits the 56px topbar). */
  .practice__session-button,
  .practice__spacer {
    min-width: 44px;
    height: 44px;
  }
}
</style>
