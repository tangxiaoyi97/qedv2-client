<script setup lang="ts">
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
import type { PartPlayerCommand, PartPlayerState } from './part-player-types.js';
import { emptySubmission, isSubmissionComplete } from '../question/submission-defaults.js';
import AnswerControl from '../question/AnswerControl.vue';
import SelfAssessmentPanel from '../question/SelfAssessmentPanel.vue';
import { answerPreview } from '../question/submission-preview.js';
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
import ResultBanner from './ResultBanner.vue';
import SolutionPanel from './SolutionPanel.vue';

const props = defineProps<{
  part: QuestionPart;
  label?: string;
  chromeless?: boolean;
  command?: PartPlayerCommand | null;
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
}>();

type Phase = 'answering' | 'self-assessing' | 'reviewed';

const phase = ref<Phase>('answering');
const result = ref<GradeResult | null>(null);
const indeterminate = ref(false);
const indeterminateMax = ref(1);
const selfAssessment = ref<SelfAssessment>({});
const selfAssessmentPoints = ref<number | null>(null);
const selfAssessmentGrading = ref<Grading | null>(null);

const answer = computed(() => props.part.answer);
const submission = ref<Submission | null>(answer.value ? emptySubmission(answer.value) : null);
const currentAnswerPreview = computed(() =>
  answer.value && submission.value ? answerPreview(answer.value, submission.value) : null,
);
const showPartHead = computed(() =>
  props.label != null || (!props.chromeless && (props.part.format != null || props.part.points != null)),
);

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
    selfAssessment: selfAssessmentState.value,
  });
});

function submit(): void {
  if (phase.value !== 'answering') return;
  if (!canSubmit.value || !submission.value) return;
  if (submission.value.kind === 'open') {
    // grade only after the user compared with the solution and self-assessed
    phase.value = 'self-assessing';
    return;
  }
  const outcome = grade(props.part, submission.value);
  if (isIndeterminate(outcome)) {
    indeterminate.value = true;
    indeterminateMax.value = outcome.maxPoints;
    phase.value = 'self-assessing';
    return;
  }
  result.value = outcome;
  phase.value = 'reviewed';
  emit('graded', { partId: props.part.id, result: outcome, submission: submission.value, selfAssessed: false });
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
}

function setSelfAssessmentGrading(grading: Grading): void {
  if (phase.value !== 'self-assessing') return;
  selfAssessmentGrading.value = grading;
}

function onSelfAssessmentUpdate(value: SelfAssessment): void {
  selfAssessment.value = value;
  const selected = selectedPointsFromAssessment(value, maxPointsForSelf.value, props.part.scoring);
  selfAssessmentPoints.value = selected;
  if (selected != null) selfAssessmentGrading.value ??= defaultGradingForScore(selected, maxPointsForSelf.value);
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
  emit('graded', {
    partId: props.part.id,
    result: final,
    submission: submission.value,
    selfAssessed: true,
    manualGrading,
  });
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Enter') return;
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
      Diese Teilaufgabe ist noch nicht beantwortbar (Inhalt in Umwandlung).
    </div>

    <template v-else>
      <ResultBanner
        v-if="!chromeless && phase === 'reviewed' && result"
        :result="result"
        class="q-part__banner"
      />

      <AnswerControl
        v-if="submission"
        v-model="submission"
        :answer="answer"
        :result="phase === 'reviewed' ? result : null"
        :indeterminate="indeterminate && phase !== 'answering'"
        :show-preview="!chromeless"
        class="q-part__control"
      />

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
          <QButton :disabled="!canConfirmSelfAssessment" @click="confirmSelfAssessment">Bewertung übernehmen</QButton>
        </div>
      </div>

      <div v-else-if="phase === 'answering' && !chromeless" class="q-part__actions">
        <span class="q-part__key-hint">↵ prüfen</span>
        <QButton :disabled="!canSubmit" @click="submit">Überprüfen</QButton>
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
