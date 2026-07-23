<script setup lang="ts">
import { computed } from 'vue';
import type { AnswerKind, Grading, GradingOrUnseen, SolutionEntry } from '@qed2/core-logic';
import {
  GradingMenu,
  QButton,
  ChevronDown,
  SELF_ASSESSMENT_GRADING_OPTIONS,
  SolutionSheet,
  StateIcon,
  onRadioGroupKeydown,
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
  /** Manual grading override — the GradingMenu lives in the bar (thumb
   *  reach) instead of the question header. */
  grading: GradingOrUnseen;
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

/** Score-tone parity with SelfAssessmentPanel: 0 → error, max → ok,
 *  anything between → accent. One „selected" language across both controls. */
function scoreTone(points: number): 'zero' | 'full' | 'mid' {
  const max = props.state.selfAssessment?.maxPoints ?? 0;
  if (points <= 0) return 'zero';
  if (max > 0 && points >= max) return 'full';
  return 'mid';
}

const VERDICT_LABELS = { correct: 'Richtig', partial: 'Teilweise richtig', incorrect: 'Falsch' } as const;
const verdictLabel = computed(() =>
  props.state.result ? VERDICT_LABELS[props.state.result.verdict] : '',
);
/** Points ride the verdict anchor — with the in-flow VerdictCard now limited
 *  to open parts, this is the only place the score shows for most kinds. */
const verdictPoints = computed(() => {
  const r = props.state.result;
  if (!r) return '';
  const fmt = (n: number): string => n.toLocaleString('de-AT');
  return `${fmt(r.awardedPoints)} / ${fmt(r.maxPoints)} P`;
});

const emit = defineEmits<{
  'update:solutionOpen': [open: boolean];
  scoreSelect: [points: number];
  /** Self-assessment mastery dropdown (only while self-assessing). */
  selfGradingSelect: [grading: Grading];
  /** GradingMenu manual override (any other phase). */
  gradingSelect: [grading: Grading];
  primary: [];
}>();

function onMasteryChange(ev: Event): void {
  const value = (ev.target as HTMLSelectElement).value as Grading | '';
  if (value) emit('selfGradingSelect', value);
}
</script>

<template>
  <div class="practice-bar">
    <SolutionSheet
      :open="solutionOpen"
      :solution="solution"
      content-max-width="860px"
      @update:open="emit('update:solutionOpen', $event)"
    />

    <div
      class="practice-bar__row"
      :class="{ 'practice-bar__row--assessment': state.phase === 'self-assessing' }"
    >
      <div class="practice-bar__left">
        <!-- mastery override rides the INFO slot (left), not the action
             cluster — and it shares the Lösung toggle's outlined geometry -->
        <GradingMenu
          v-if="state.phase !== 'self-assessing'"
          :grading="grading"
          class="practice-bar__grading"
          @select="emit('gradingSelect', $event)"
        />
        <!-- compact verdict anchor; the authoritative card is in the flow -->
        <div
          v-if="state.result"
          class="practice-bar__verdict"
          :class="`practice-bar__verdict--${state.result.verdict}`"
        >
          <StateIcon :state="state.result.verdict" :size="18" />
          <span>{{ verdictLabel }}</span>
          <span class="practice-bar__verdict-points">{{ verdictPoints }}</span>
        </div>
        <div v-else-if="state.phase === 'self-assessing' && state.selfAssessment" class="practice-bar__assessment">
          <div v-if="!rubricMode" class="practice-bar__assessment-group">
            <span class="practice-bar__assessment-label">Punkte</span>
            <div class="practice-bar__score-options" role="radiogroup" aria-label="Punkte" @keydown="onRadioGroupKeydown">
              <button
                v-for="option in state.selfAssessment.scoreOptions"
                :key="option.points"
                type="button"
                class="practice-bar__score-option"
                :class="[
                  sameScore(state.selfAssessment.selectedPoints, option.points)
                    ? `practice-bar__score-option--${scoreTone(option.points)}`
                    : '',
                ]"
                role="radio"
                :aria-checked="sameScore(state.selfAssessment.selectedPoints, option.points)"
                @click="emit('scoreSelect', option.points)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="practice-bar__assessment-group practice-bar__assessment-group--mastery">
            <span class="practice-bar__assessment-label">Bewertung</span>
            <span class="practice-bar__mastery-select-wrap">
              <select
                class="practice-bar__mastery-select"
                aria-label="Bewertung"
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
              <ChevronDown class="practice-bar__select-chevron" />
            </span>
          </div>
        </div>
        <div v-else-if="answerPreview" class="practice-bar__preview">
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
          Lösung <ChevronDown class="practice-bar__solution-chevron" />
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
}

/* compact verdict anchor in the left slot — the full feedback card lives
 * in the content flow (VerdictCard); the bar itself stays neutral. */
.practice-bar__verdict {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.practice-bar__verdict--correct {
  color: var(--q-ok);
}
.practice-bar__verdict--partial {
  color: var(--q-part-ink);
}
.practice-bar__verdict--incorrect {
  color: var(--q-err);
}
.practice-bar__verdict-points {
  font: 700 12px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.practice-bar__row {
  max-width: 1040px;
  margin: 0 auto;
  padding: 12px 28px calc(12px + env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 68px;
  flex-wrap: wrap;
}

.practice-bar__row--assessment {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.practice-bar__row--assessment .practice-bar__left {
  width: 100%;
}

.practice-bar__row--assessment .practice-bar__right {
  margin-left: 0;
}

.practice-bar__left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 44px;
  min-width: 0;
  flex: 1;
}

/* the capsule keeps its state tint, but takes the Lösung toggle's outlined
 * geometry so the bar reads as ONE control family */
.practice-bar__grading :deep(.q-grading-capsule) {
  min-height: 42px;
  padding: 0 14px;
  border-radius: 9px;
  gap: 7px;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
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
  flex: 1 1 280px;
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

.practice-bar__mastery-select-wrap {
  position: relative;
  display: inline-flex;
  width: clamp(180px, 22vw, 260px);
  max-width: 100%;
}

.practice-bar__mastery-select {
  min-height: 32px;
  width: 100%;
  border: 1px solid var(--q-part-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--q-card) 88%, transparent);
  color: var(--q-part-ink);
  font: 750 12px 'Public Sans', system-ui, sans-serif;
  padding: 0 var(--q-control-chevron-padding-end) 0 12px;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}

.practice-bar__select-chevron {
  position: absolute;
  right: var(--q-control-chevron-inset);
  top: 50%;
  transform: translateY(-50%);
  color: var(--q-part-ink);
  font-size: 16px;
  pointer-events: none;
}

.practice-bar__row--assessment .practice-bar__score-option,
.practice-bar__row--assessment .practice-bar__mastery-select,
.practice-bar__row--assessment .practice-bar__solution-toggle {
  box-sizing: border-box;
  min-height: 42px;
  height: 42px;
}

.practice-bar__row--assessment .practice-bar__right :deep(.q-btn) {
  box-sizing: border-box;
  min-height: 42px;
  height: 42px;
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

.practice-bar__score-option--zero {
  background: var(--q-err);
  border-color: var(--q-err);
  color: var(--q-on-err);
}
.practice-bar__score-option--full {
  background: var(--q-ok);
  border-color: var(--q-ok);
  color: var(--q-on-ok);
}
.practice-bar__score-option--mid {
  background: var(--q-accent);
  border-color: var(--q-accent);
  color: var(--q-on-accent);
}

.practice-bar__solution-chevron {
  display: inline-block;
}

@media (pointer: coarse) {
  /* 44px touch targets for the self-assessment controls */
  .practice-bar__score-option {
    min-height: 44px;
    min-width: 48px;
  }
  .practice-bar__mastery-select {
    min-height: 44px;
  }

  .practice-bar__row--assessment .practice-bar__score-option,
  .practice-bar__row--assessment .practice-bar__mastery-select,
  .practice-bar__row--assessment .practice-bar__solution-toggle,
  .practice-bar__row--assessment .practice-bar__right :deep(.q-btn) {
    min-height: 44px;
    height: 44px;
  }
}

.practice-bar__solution-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 var(--q-control-chevron-inset);
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

  .practice-bar__row--assessment {
    grid-template-columns: minmax(0, 1fr);
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

  .practice-bar__assessment-group--mastery {
    align-items: center;
    flex-direction: row;
  }

  .practice-bar__mastery-select-wrap {
    width: auto;
    min-width: 0;
    flex: 1 1 auto;
  }

  .practice-bar__row--assessment .practice-bar__right {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (min-width: 641px) and (max-width: 900px) {
  .practice-bar__row--assessment {
    grid-template-columns: minmax(0, 1fr);
  }

  .practice-bar__row--assessment .practice-bar__right {
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
