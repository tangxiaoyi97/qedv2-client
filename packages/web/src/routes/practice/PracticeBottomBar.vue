<script setup lang="ts">
import { computed } from 'vue';
import type { AnswerKind, Grading, SolutionEntry } from '@qed2/core-logic';
import {
  QButton,
  ResultPill,
  SELF_ASSESSMENT_GRADING_OPTIONS,
  SolutionSheet,
  sameScore,
} from '@qed2/ui';
import type { AnswerPreview, PartPlayerState } from '@qed2/ui';

const props = defineProps<{
  state: PartPlayerState;
  answerPreview: AnswerPreview | null;
  /** Current part's answer kind — the idle hint's verb depends on it. */
  answerKind?: AnswerKind;
  /** Rubric criteria are rendered in the question body, not as total buttons. */
  rubricMode?: boolean;
  solution?: SolutionEntry[];
  solutionOpen: boolean;
  primaryLabel: string;
  primaryDisabled: boolean;
}>();

/** Selection questions are picked, not typed — match the hint's verb. */
const idleHint = computed(() => {
  switch (props.answerKind) {
    case 'choice':
    case 'matching':
      return 'Antwort oben auswählen …';
    case 'open':
      return 'Antwort oben bearbeiten …';
    default:
      return 'Antwort oben eintragen …';
  }
});

const emit = defineEmits<{
  'update:solutionOpen': [open: boolean];
  scoreSelect: [points: number];
  gradingSelect: [grading: Grading];
  primary: [];
}>();

function onMasteryChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement).value as Grading | '';
  if (value) emit('gradingSelect', value);
}
</script>

<template>
  <div
    class="practice-bar"
    :class="{
      'practice-bar--ok': state.result?.verdict === 'correct',
      'practice-bar--err': state.result != null && state.result.verdict === 'incorrect',
      'practice-bar--part': state.result?.verdict === 'partial' || state.phase === 'self-assessing',
    }"
  >
    <SolutionSheet
      :open="solutionOpen"
      :solution="solution"
      content-max-width="860px"
      @update:open="emit('update:solutionOpen', $event)"
    />

    <div class="practice-bar__row">
      <div class="practice-bar__left">
        <ResultPill v-if="state.result" :result="state.result" />
        <div v-else-if="state.phase === 'self-assessing' && state.selfAssessment" class="practice-bar__assessment">
          <div v-if="!rubricMode" class="practice-bar__assessment-group">
            <span class="practice-bar__assessment-label">Punkte</span>
            <div class="practice-bar__score-options" role="radiogroup" aria-label="Punkte">
              <button
                v-for="option in state.selfAssessment.scoreOptions"
                :key="option.points"
                type="button"
                class="practice-bar__score-option"
                :class="{ 'practice-bar__score-option--on': sameScore(state.selfAssessment.selectedPoints, option.points) }"
                role="radio"
                :aria-checked="sameScore(state.selfAssessment.selectedPoints, option.points)"
                @click="emit('scoreSelect', option.points)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <span v-else class="practice-bar__rubric-hint">Bewertungsraster oben ausfüllen</span>

          <div class="practice-bar__assessment-group practice-bar__assessment-group--mastery">
            <span class="practice-bar__assessment-label">Beherrschung</span>
            <select
              class="practice-bar__mastery-select"
              aria-label="Beherrschung"
              :value="state.selfAssessment.grading ?? ''"
              @change="onMasteryChange"
            >
              <option disabled value="">auswählen …</option>
              <option
                v-for="option in SELF_ASSESSMENT_GRADING_OPTIONS"
                :key="option.grading"
                :value="option.grading"
              >
                {{ option.label }} · {{ option.hint }}
              </option>
            </select>
          </div>
        </div>
        <div v-else-if="answerPreview" class="practice-bar__preview" aria-live="polite">
          <span class="practice-bar__preview-main">
            <span class="practice-bar__preview-label">{{ answerPreview.label }}:</span>
            <b class="practice-bar__preview-value">{{ answerPreview.value }}</b>
          </span>
          <span v-if="answerPreview.hint" class="practice-bar__preview-hint">{{ answerPreview.hint }}</span>
        </div>
        <span v-else class="practice-bar__hint practice-bar__hint--quiet">{{ idleHint }}</span>
      </div>

      <div class="practice-bar__right">
        <button
          v-if="state.phase !== 'answering'"
          type="button"
          class="practice-bar__solution-toggle"
          :class="{ 'practice-bar__solution-toggle--on': solutionOpen }"
          :aria-expanded="solutionOpen"
          @click="emit('update:solutionOpen', !solutionOpen)"
        >
          Lösung <span aria-hidden="true">{{ solutionOpen ? '▾' : '▴' }}</span>
        </button>
        <QButton :disabled="primaryDisabled" @click="emit('primary')">{{ primaryLabel }}</QButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.practice-bar {
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

.practice-bar--ok {
  border-top-color: var(--q-ok-border);
  background: color-mix(in srgb, var(--q-ok-bg) 35%, var(--q-card));
}

.practice-bar--err {
  border-top-color: var(--q-err-border);
  background: color-mix(in srgb, var(--q-err-bg) 35%, var(--q-card));
}

.practice-bar--part {
  border-top-color: var(--q-part-border);
  background: color-mix(in srgb, var(--q-part-bg) 35%, var(--q-card));
}

.practice-bar__row {
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

.practice-bar__left {
  display: flex;
  align-items: center;
  min-height: 44px;
  min-width: 0;
  flex: 1;
}

.practice-bar__right {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

.practice-bar__hint {
  font-size: 12.5px;
  color: var(--q-part-ink);
  font-weight: 600;
}

.practice-bar__hint--quiet {
  color: var(--q-hint);
  font-weight: 400;
  font-style: italic;
}
.practice-bar__rubric-hint {
  font-size: 12.5px;
  color: var(--q-mut);
}

.practice-bar__preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.practice-bar__preview-main {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-size: 13.5px;
  color: var(--q-mut-2);
}

.practice-bar__preview-label {
  font-weight: 600;
}

.practice-bar__preview-value {
  color: var(--q-ink);
  font-size: 15px;
}

.practice-bar__preview-hint {
  font: 500 11px ui-monospace, Menlo, monospace;
  color: var(--q-hint);
}

.practice-bar__assessment {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  flex-wrap: wrap;
}

.practice-bar__assessment-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.practice-bar__assessment-group--mastery {
  flex: 1;
}

.practice-bar__assessment-label {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--q-part-ink);
  flex: none;
}

.practice-bar__score-options {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex-wrap: wrap;
}

.practice-bar__score-option {
  min-height: 30px;
  border: 1px solid var(--q-part-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--q-card) 82%, transparent);
  color: var(--q-part-ink);
  font-family: inherit;
  font-weight: 750;
  cursor: pointer;
}

.practice-bar__score-option {
  min-width: 42px;
  padding: 0 11px;
  font-size: 12.5px;
}

.practice-bar__mastery-select {
  min-height: 32px;
  width: min(260px, 34vw);
  border: 1px solid var(--q-part-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--q-card) 88%, transparent);
  color: var(--q-part-ink);
  font: 750 12px 'Public Sans', system-ui, sans-serif;
  padding: 0 10px;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .practice-bar__score-option:hover,
  .practice-bar__mastery-select:hover {
    border-color: var(--q-accent);
  }
}

.practice-bar__score-option:focus-visible,
.practice-bar__mastery-select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}

.practice-bar__score-option--on {
  background: var(--q-accent);
  border-color: var(--q-accent);
  color: var(--q-on-accent);
}

.practice-bar__solution-toggle {
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

@media (hover: hover) and (pointer: fine) {
  .practice-bar__solution-toggle:hover {
    color: var(--q-ink);
    border-color: var(--q-border-3);
  }
}

.practice-bar__solution-toggle--on {
  border-color: var(--q-accent);
  color: var(--q-accent-strong);
  background: var(--q-accent-bg);
}

@media (max-width: 640px) {
  .practice-bar__row {
    padding-left: 16px;
    padding-right: 16px;
  }

  .practice-bar__left,
  .practice-bar__assessment,
  .practice-bar__assessment-group {
    width: 100%;
  }

  .practice-bar__assessment {
    gap: 9px;
  }

  .practice-bar__assessment-group {
    align-items: flex-start;
    flex-direction: column;
  }

  .practice-bar__mastery-select {
    width: 100%;
  }

  .practice-bar__right {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 1023px) {
  .practice-bar {
    left: 0;
    border-left: none;
  }
}
</style>
