<script setup lang="ts">
import { useI18n } from '../i18n.js';

/**
 * PartPlayer — one part's full answer cycle (supplement §0):
 *
 *   answering ──Überprüfen──► graded? ──► reviewed
 *        │                       │
 *        │ (open kind)           │ (expression: CAS indeterminate)
 *        ▼                       ▼
 *   self-assessing (rubric + SelfAssessmentPanel) ──► reviewed
 *
 * Grading is pure and lives in @qed2/core-logic; this component only drives
 * the state machine and emits the final result upward (FSRS/archive/sync are
 * the shell's job).
 *
 * Two chrome modes (part-player-types.ts is the shell contract):
 *  - chromeless falsy (default): fully self-contained — ResultBanner,
 *    SolutionPanel and its own action buttons, exactly as before, so any
 *    existing consumer keeps working unchanged.
 *  - chromeless=true (practice page): the shell owns the feedback pill, the
 *    solution sheet and the primary action button (sticky bottom bar).
 *    PartPlayer renders only the part head, prompt and AnswerControl. It
 *    reports every phase/canSubmit/result/self-assessment change via the
 *    `state` event and exposes submit()/confirmSelfAssessment() for the shell
 *    to trigger.
 *    During 'self-assessing' the user must compare against the official
 *    solution: the SHELL auto-opens its SolutionSheet when it sees that state.
 */
import { computed, ref, watch, watchEffect } from 'vue';
import {
  grade,
  isIndeterminate,
  type GradeResult,
  type Grading,
  type QuestionPart,
  type SelfAssessment,
  type Submission,
} from '@qed2/core-logic';
import type { PartPlayerCommand, PartPlayerDraft, PartPlayerState } from './part-player-types.js';
import { emptySubmission, isSubmissionComplete } from '../question/submission-defaults.js';
import AnswerControl from '../question/AnswerControl.vue';
import SelfAssessmentPanel from '../question/SelfAssessmentPanel.vue';
import { answerPreview } from '../question/submission-preview.js';
import { submittedText } from '@qed2/core-logic';
import {
  defaultGradingForScore,
  gradeResultFromScore,
  maxPointsForScoring,
  sameScore,
  scoreOptionsForPart,
  selectedPointsFromAssessment,
  selfAssessmentOverallForScore,
} from './self-assessment.js';
import RichTextView from '../shared/RichTextView.vue';
import FigureList from '../shared/FigureList.vue';
import QButton from '../shared/QButton.vue';
import QChip from '../shared/QChip.vue';
import VerdictCard from './VerdictCard.vue';
import SolutionPanel from './SolutionPanel.vue';

const { t } = useI18n();

const props = defineProps<{
  part: QuestionPart;
  label?: string;
  chromeless?: boolean;
  command?: PartPlayerCommand | null;
  /** Durable result restored after a crash without grading the answer again. */
  restoredFirstResult?: GradeResult;
  /** Short-lived local answer snapshot, retained while its review is open. */
  restoredSubmission?: Submission;
  /** The durable result exists, but its private answer was intentionally discarded. */
  restoredSubmissionUnavailable?: boolean;
  /** Local-only first-attempt state saved before the official solution opens. */
  restoredDraft?: PartPlayerDraft;
  /** Local-only answer edit restored before the first submission. */
  restoredAnswerDraft?: Submission;
}>();

const emit = defineEmits<{
  graded: [payload: {
    partId: string;
    result: GradeResult;
    submission: Submission;
    selfAssessed: boolean;
    manualGrading?: Grading;
  }];
  state: [payload: PartPlayerState];
  draft: [payload: PartPlayerDraft];
  answerDraft: [payload: Submission];
}>();

type Phase = 'answering' | 'self-assessing' | 'reviewed';

const phase = ref<Phase>(props.restoredFirstResult
  ? 'reviewed'
  : props.restoredDraft
    ? 'self-assessing'
    : 'answering');
const result = ref<GradeResult | null>(props.restoredFirstResult ?? null);
const indeterminate = ref(props.restoredDraft?.indeterminate ?? false);
const indeterminateMax = ref(props.restoredDraft?.indeterminateMax ?? 1);
const selfAssessment = ref<SelfAssessment>(props.restoredDraft
  ? {
      ...props.restoredDraft.assessment,
      ...(props.restoredDraft.assessment.criteriaMet
        ? { criteriaMet: [...props.restoredDraft.assessment.criteriaMet] }
        : {}),
    }
  : {});
const selfAssessmentPoints = ref<number | null>(props.restoredDraft?.selectedPoints ?? null);
const selfAssessmentGrading = ref<Grading | null>(props.restoredDraft?.grading ?? null);
const reviewSubmissionUnavailable = ref(props.restoredSubmissionUnavailable === true);

const answer = computed(() => props.part.answer);
const submission = ref<Submission | null>(
  props.restoredDraft?.submission
    ?? props.restoredSubmission
    ?? props.restoredAnswerDraft
    ? cloneSubmission((
        props.restoredDraft?.submission
        ?? props.restoredSubmission
        ?? props.restoredAnswerDraft
      )!)
    : answer.value
      ? emptySubmission(answer.value)
      : null,
);
const currentAnswerPreview = computed(() =>
  answer.value && submission.value ? answerPreview(answer.value, submission.value) : null,
);
const showPartHead = computed(() =>
  props.label != null || (!props.chromeless && (props.part.format != null || props.part.points != null)),
);

function cloneSubmission(value: Submission): Submission {
  switch (value.kind) {
    case 'choice': return { kind: 'choice', selected: [...value.selected] };
    case 'matching': return { kind: 'matching', matches: [...value.matches] };
    case 'numeric': return { kind: 'numeric', values: { ...value.values } };
    case 'interval': return { ...value };
    case 'expression': return { ...value };
    case 'open': return {
      kind: 'open',
      text: value.text,
      selfAssessment: {
        ...value.selfAssessment,
        ...(value.selfAssessment.criteriaMet
          ? { criteriaMet: [...value.selfAssessment.criteriaMet] }
          : {}),
      },
    };
  }
}

const canSubmit = computed(
  () => answer.value != null && submission.value != null && isSubmissionComplete(answer.value, submission.value),
);

const maxPointsForSelf = computed(() => {
  if (indeterminate.value) return indeterminateMax.value;
  return maxPointsForScoring(props.part.scoring, props.part.points);
});
const selfScoreOptions = computed(() => scoreOptionsForPart(props.part, indeterminate.value ? indeterminateMax.value : undefined));
const canConfirmSelfAssessment = computed(() => selfAssessmentPoints.value != null);
const selfAssessmentState = computed(() =>
  phase.value === 'self-assessing'
    ? {
        maxPoints: maxPointsForSelf.value,
        scoreOptions: selfScoreOptions.value,
        selectedPoints: selfAssessmentPoints.value,
        grading: selfAssessmentGrading.value,
        assessment: selfAssessment.value,
      }
    : null,
);

// Shell contract: emit the full state on mount and on every phase /
// canSubmit / result change (canSubmit re-evaluates whenever the AnswerControl
// replaces the submission ref, i.e. on every input).
watchEffect(() => {
  emit('state', {
    phase: phase.value,
    canSubmit: phase.value === 'answering' && canSubmit.value,
    result: result.value,
    indeterminate: indeterminate.value,
    unplayable: !answer.value,
    answerPreview: currentAnswerPreview.value,
    submittedText: submittedText(submission.value, answer.value),
    selfAssessment: selfAssessmentState.value,
  });
});

/**
 * Draft events are explicit user intents, not reactive projections. Emitting
 * them from the state watchEffect lets a synchronous parent listener's reads
 * become dependencies of this component effect; the parent's eventual save
 * then retriggers the effect and creates an endless save echo.
 */
function emitSelfAssessmentDraft(): void {
  if (phase.value !== 'self-assessing' || !submission.value) return;
  emit('draft', {
    submission: cloneSubmission(submission.value),
    assessment: {
      ...selfAssessment.value,
      ...(selfAssessment.value.criteriaMet
        ? { criteriaMet: [...selfAssessment.value.criteriaMet] }
        : {}),
    },
    selectedPoints: selfAssessmentPoints.value,
    grading: selfAssessmentGrading.value,
    indeterminate: indeterminate.value,
    indeterminateMax: indeterminateMax.value,
  });
}

function onSubmissionUpdate(value: Submission): void {
  if (phase.value !== 'answering') return;
  submission.value = cloneSubmission(value);
  emit('answerDraft', cloneSubmission(value));
}

function submit(): void {
  if (phase.value !== 'answering') return;
  if (!canSubmit.value || !submission.value) return;
  if (submission.value.kind === 'open') {
    // grade only after the user compared with the solution and self-assessed
    phase.value = 'self-assessing';
    emitSelfAssessmentDraft();
    return;
  }
  const outcome = grade(props.part, submission.value);
  if (isIndeterminate(outcome)) {
    indeterminate.value = true;
    indeterminateMax.value = outcome.maxPoints;
    phase.value = 'self-assessing';
    emitSelfAssessmentDraft();
    return;
  }
  result.value = outcome;
  phase.value = 'reviewed';
  emitOutcome(outcome, submission.value, false);
}

function emitOutcome(outcome: GradeResult, value: Submission, selfAssessed: boolean, manualGrading?: Grading): void {
  emit('graded', {
    partId: props.part.id,
    result: outcome,
    submission: value,
    selfAssessed,
    ...(manualGrading ? { manualGrading } : {}),
  });
}

function restoreReview(
  restoredResult: GradeResult,
  restoredSubmission?: Submission,
  submissionUnavailable = false,
): void {
  if (restoredSubmission) submission.value = cloneSubmission(restoredSubmission);
  else if (answer.value) submission.value = emptySubmission(answer.value);
  reviewSubmissionUnavailable.value = submissionUnavailable;
  result.value = restoredResult;
  phase.value = 'reviewed';
  indeterminate.value = false;
}

function setSelfAssessmentScore(points: number): void {
  if (phase.value !== 'self-assessing') return;
  const option = selfScoreOptions.value.find((o) => sameScore(o.points, points));
  if (!option) return;
  selfAssessmentPoints.value = option.points;
  const max = maxPointsForSelf.value;
  selfAssessment.value = {
    ...selfAssessment.value,
    awardedPoints: option.points,
    overall: selfAssessmentOverallForScore(option.points, max),
  };
  selfAssessmentGrading.value ??= defaultGradingForScore(option.points, max);
  emitSelfAssessmentDraft();
}

function setSelfAssessmentGrading(grading: Grading): void {
  if (phase.value !== 'self-assessing') return;
  selfAssessmentGrading.value = grading;
  emitSelfAssessmentDraft();
}

function onSelfAssessmentUpdate(value: SelfAssessment): void {
  selfAssessment.value = value;
  const selected = selectedPointsFromAssessment(value, maxPointsForSelf.value, props.part.scoring);
  selfAssessmentPoints.value = selected;
  if (selected != null) selfAssessmentGrading.value ??= defaultGradingForScore(selected, maxPointsForSelf.value);
  emitSelfAssessmentDraft();
}

/** Chromeless shells render their own SelfAssessmentPanel and feed changes
 * back through this method so grading still has one authoritative state. */
function setSelfAssessment(value: SelfAssessment): void {
  if (phase.value !== 'self-assessing') return;
  onSelfAssessmentUpdate(value);
}

watch(
  () => props.command,
  (command) => {
    if (!command) return;
    switch (command.type) {
      case 'submit':
        submit();
        break;
      case 'confirm-self-assessment':
        confirmSelfAssessment();
        break;
      case 'restore-review':
        restoreReview(command.result, command.submission, command.submissionUnavailable);
        break;
      case 'set-score':
        setSelfAssessmentScore(command.points);
        break;
      case 'set-grading':
        setSelfAssessmentGrading(command.grading);
        break;
      case 'set-assessment':
        setSelfAssessment(command.assessment);
        break;
    }
  },
);

function confirmSelfAssessment(): void {
  if (phase.value !== 'self-assessing') return;
  if (!submission.value) return;
  if (!canConfirmSelfAssessment.value) return;
  const awardedPoints = selfAssessmentPoints.value;
  if (awardedPoints == null) return;
  const max = maxPointsForSelf.value;
  const manualGrading = selfAssessmentGrading.value ?? defaultGradingForScore(awardedPoints, max);
  let final: GradeResult;
  if (submission.value.kind === 'open') {
    const withAssessment: Submission = {
      ...submission.value,
      selfAssessment: {
        ...selfAssessment.value,
        awardedPoints,
        overall: selfAssessmentOverallForScore(awardedPoints, max),
      },
    };
    submission.value = withAssessment;
    const outcome = grade(props.part, withAssessment);
    if (isIndeterminate(outcome)) return; // open never yields indeterminate
    final = outcome;
  } else {
    // expression fell back to self-assessment: use the exact supported score
    // selected by the user, not a hard-coded half-point mapping.
    final = gradeResultFromScore(awardedPoints, max);
  }
  result.value = final;
  phase.value = 'reviewed';
  emitOutcome(final, submission.value, true, manualGrading);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Enter' || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
  const target = ev.target as HTMLElement | null;
  // Native interactive elements own their Enter behavior: buttons toggle/
  // activate, selects open the dropdown, links navigate. Hijacking those to
  // mean "submit" breaks keyboard and screen-reader interaction.
  if (target?.closest('button, select, textarea, a, [role="button"], [role="radio"], [role="checkbox"]'))
    return;
  if (phase.value === 'answering' && canSubmit.value) {
    ev.preventDefault();
    submit();
  }
}

defineExpose({
  submit,
  confirmSelfAssessment,
  setSelfAssessmentScore,
  setSelfAssessmentGrading,
  setSelfAssessment,
});
</script>

<template>
  <div class="q-part" @keydown="onKeydown">
    <div v-if="showPartHead" class="q-part__head">
      <span v-if="label" class="q-part__label">{{ label }}</span>
      <QChip v-if="!chromeless && part.format" tone="neutral">{{ part.format }}</QChip>
      <span v-if="!chromeless && part.points != null" class="q-part__points">{{ part.points }} P</span>
    </div>

    <div v-if="part.prompt && part.prompt.length > 0" class="q-part__prompt">
      <RichTextView :nodes="part.prompt" />
    </div>
    <FigureList :figures="part.figures" />

    <div v-if="!answer" class="q-part__unplayable">
      {{ t('Diese Teilaufgabe ist noch nicht beantwortbar (Inhalt in Umwandlung).') }}
    </div>

    <template v-else>
      <VerdictCard
        v-if="!chromeless && phase === 'reviewed' && result"
        :result="result"
        :solution-link="false"
        class="q-part__banner"
      />

      <AnswerControl
        v-if="submission && !reviewSubmissionUnavailable"
        :model-value="submission"
        :answer="answer"
        :result="phase === 'reviewed' ? result : null"
        :indeterminate="indeterminate && phase !== 'answering'"
        :show-preview="!chromeless"
        :locked="phase === 'self-assessing'"
        class="q-part__control"
        @update:model-value="onSubmissionUpdate"
      />
      <p v-else-if="reviewSubmissionUnavailable" class="q-part__remote-review" role="status">
        {{ t('Diese Aufgabe wurde in einem anderen Fenster gespeichert.') }}
      </p>

      <div v-if="phase === 'self-assessing' && !chromeless" class="q-part__selfassess">
        <!-- chromeless: the shell auto-opens its SolutionSheet for comparison -->
        <SolutionPanel :solution="part.solution" :default-open="true" />
        <SelfAssessmentPanel
          :model-value="selfAssessment"
          :scoring="part.scoring"
          :rubric="answer.kind === 'open' ? answer.rubric : undefined"
          :max-points="maxPointsForSelf"
          :score-options="selfScoreOptions"
          @update:model-value="onSelfAssessmentUpdate"
        />
        <div class="q-part__actions">
          <QButton :disabled="!canConfirmSelfAssessment" @click="confirmSelfAssessment">{{ t('Bewertung übernehmen') }}</QButton>
        </div>
      </div>

      <div v-else-if="phase === 'answering' && !chromeless" class="q-part__actions">
        <span class="q-part__key-hint">{{ t('↵ prüfen') }}</span>
        <QButton :disabled="!canSubmit" @click="submit">{{ t('Überprüfen') }}</QButton>
      </div>

      <SolutionPanel
        v-if="!chromeless && phase === 'reviewed'"
        :solution="part.solution"
        :default-open="true"
        class="q-part__solution"
      />
    </template>
  </div>
</template>

<style scoped>
.q-part__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.q-part__label {
  font-weight: 800;
  font-size: 15px;
}
.q-part__points {
  margin-left: auto;
  font-size: 12px;
  color: var(--q-faint);
}
.q-part__prompt {
  font-size: 15px;
  line-height: 1.65;
  margin-bottom: 14px;
  /* wide inline KaTeX scrolls here instead of panning the whole page */
  overflow-x: auto;
}
.q-part__unplayable {
  padding: 14px;
  border: 1px solid var(--q-neutral-border);
  background: var(--q-neutral-bg);
  color: var(--q-mut);
  border-radius: 10px;
  font-size: 13px;
}
.q-part__banner {
  margin-bottom: 14px;
}
.q-part__control {
  margin-bottom: 4px;
}
.q-part__selfassess {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-part__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 16px;
}
.q-part__key-hint {
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}
.q-part__solution {
  margin-top: 16px;
}
</style>
