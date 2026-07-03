<script setup lang="ts">
/**
 * PartPlayer — one part's full answer cycle (supplement §0):
 *
 *   answering ──Überprüfen──► graded? ──► reviewed (banner + marks + solution)
 *        │                       │
 *        │ (open kind)           │ (expression: CAS indeterminate)
 *        ▼                       ▼
 *   self-assessing (solution + rubric + SelfAssessmentPanel) ──► reviewed
 *
 * Grading is pure and lives in @qed2/core-logic; this component only drives
 * the state machine and emits the final result upward (FSRS/archive/sync are
 * the shell's job).
 */
import { computed, reactive, ref } from 'vue';
import {
  grade,
  isIndeterminate,
  type GradeResult,
  type QuestionPart,
  type SelfAssessment,
  type Submission,
} from '@qed2/core-logic';
import { emptySubmission, isSubmissionComplete } from '../question/submission-defaults.js';
import AnswerControl from '../question/AnswerControl.vue';
import SelfAssessmentPanel from '../question/SelfAssessmentPanel.vue';
import RichTextView from '../shared/RichTextView.vue';
import QButton from '../shared/QButton.vue';
import QChip from '../shared/QChip.vue';
import ResultBanner from './ResultBanner.vue';
import SolutionPanel from './SolutionPanel.vue';

const props = defineProps<{
  part: QuestionPart;
  label?: string;
}>();

const emit = defineEmits<{
  graded: [payload: { partId: string; result: GradeResult; submission: Submission; selfAssessed: boolean }];
}>();

type Phase = 'answering' | 'self-assessing' | 'reviewed';

const phase = ref<Phase>('answering');
const result = ref<GradeResult | null>(null);
const indeterminate = ref(false);
const indeterminateMax = ref(1);
const selfAssessment = reactive<SelfAssessment>({});

const answer = computed(() => props.part.answer);
const submission = ref<Submission | null>(answer.value ? emptySubmission(answer.value) : null);

const canSubmit = computed(
  () => answer.value != null && submission.value != null && isSubmissionComplete(answer.value, submission.value),
);

const maxPointsForSelf = computed(() => {
  if (props.part.scoring?.mode === 'rubric') {
    return props.part.scoring.criteria.reduce((s, c) => s + c.points, 0);
  }
  if (props.part.scoring?.mode === 'allOrNothing') return props.part.scoring.points;
  return indeterminate.value ? indeterminateMax.value : (props.part.points ?? 1);
});

function submit(): void {
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

function confirmSelfAssessment(): void {
  if (!submission.value) return;
  let final: GradeResult;
  if (submission.value.kind === 'open') {
    const withAssessment: Submission = { ...submission.value, selfAssessment: { ...selfAssessment } };
    submission.value = withAssessment;
    const outcome = grade(props.part, withAssessment);
    if (isIndeterminate(outcome)) return; // open never yields indeterminate
    final = outcome;
  } else {
    // expression fell back to self-assessment: map overall → points
    const max = indeterminateMax.value;
    const overall = selfAssessment.overall ?? 'none';
    const awarded = overall === 'full' ? max : overall === 'partial' ? Math.round((max / 2) * 100) / 100 : 0;
    const verdict = overall === 'full' ? 'correct' : overall === 'partial' ? 'partial' : 'incorrect';
    final = { verdict, correct: verdict === 'correct', awardedPoints: awarded, maxPoints: max };
  }
  result.value = final;
  phase.value = 'reviewed';
  emit('graded', {
    partId: props.part.id,
    result: final,
    submission: submission.value,
    selfAssessed: true,
  });
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Enter') return;
  const target = ev.target as HTMLElement | null;
  if (target?.tagName === 'TEXTAREA') return;
  if (phase.value === 'answering' && canSubmit.value) {
    ev.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="q-part" @keydown="onKeydown">
    <div v-if="label || part.points != null" class="q-part__head">
      <span v-if="label" class="q-part__label">{{ label }}</span>
      <QChip v-if="part.format" tone="neutral">{{ part.format }}</QChip>
      <span v-if="part.points != null" class="q-part__points">{{ part.points }} P</span>
    </div>

    <div v-if="part.prompt && part.prompt.length > 0" class="q-part__prompt">
      <RichTextView :nodes="part.prompt" />
    </div>

    <div v-if="!answer" class="q-part__unplayable">
      Diese Teilaufgabe ist noch nicht beantwortbar (Inhalt in Umwandlung).
    </div>

    <template v-else>
      <ResultBanner v-if="phase === 'reviewed' && result" :result="result" class="q-part__banner" />

      <AnswerControl
        v-if="submission"
        v-model="submission"
        :answer="answer"
        :result="phase === 'reviewed' ? result : null"
        :indeterminate="indeterminate && phase !== 'answering'"
        class="q-part__control"
      />

      <div v-if="phase === 'self-assessing'" class="q-part__selfassess">
        <SolutionPanel :solution="part.solution" :default-open="true" />
        <SelfAssessmentPanel
          v-model="selfAssessment"
          :scoring="part.scoring"
          :rubric="answer.kind === 'open' ? answer.rubric : undefined"
          :max-points="maxPointsForSelf"
        />
        <div class="q-part__actions">
          <QButton @click="confirmSelfAssessment">Bewertung übernehmen</QButton>
        </div>
      </div>

      <div v-else-if="phase === 'answering'" class="q-part__actions">
        <span class="q-part__key-hint">↵ prüfen</span>
        <QButton :disabled="!canSubmit" @click="submit">Überprüfen</QButton>
      </div>

      <SolutionPanel
        v-if="phase === 'reviewed'"
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
