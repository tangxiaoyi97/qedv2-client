<script setup lang="ts">
import { computed } from 'vue';
import {
  VERDICT_LABELS,
  formatScore,
  formatScoreRatio,
  type Grading,
  type GradingOrUnseen,
  type RichText,
  type Scoring,
  type SelfAssessment,
  type SolutionEntry,
} from '@qed2/core-logic';
import GradingMenu from '../shared/GradingMenu.vue';
import GradingPicker from '../shared/GradingPicker.vue';
import QButton from '../shared/QButton.vue';
import ChevronDown from '../shared/ChevronDown.vue';
import SelfAssessmentPanel from '../question/SelfAssessmentPanel.vue';
import SolutionSheet from './SolutionSheet.vue';
import type { AnswerPreview } from '../question/submission-preview.js';
import type { PartPlayerState } from './part-player-types.js';
import type { SheetDetent } from './SolutionSheet.vue';

const props = defineProps<{
  state: PartPlayerState;
  answerPreview: AnswerPreview | null;
  /** Forwarded to the self-assessment panel inside the sheet. */
  scoring?: Scoring | null;
  rubric?: RichText | null;
  solution?: SolutionEntry[];
  solutionDetent: SheetDetent;
  /** Forwarded to the sheet: room the shell's top bar needs at full screen. */
  topReserve?: number;
  /** Manual grading override — the GradingMenu lives in the bar (thumb
   *  reach) instead of the question header. */
  grading: GradingOrUnseen;
  primaryLabel: string;
  primaryDisabled: boolean;
}>();

const assessing = computed(() => props.state.phase === 'self-assessing');

/**
 * Running total while self-assessing. The panel that owns the choice now
 * lives in the sheet, which the user can shut — so the bar keeps the one
 * number they need to see before committing.
 */
const assessedScore = computed(() => {
  const self = props.state.selfAssessment;
  if (!self) return '';
  const points = self.selectedPoints;
  return `${points == null ? '–' : formatScore(points)} / ${formatScore(self.maxPoints)}`;
});

const verdictLabel = computed(() =>
  props.state.result ? VERDICT_LABELS[props.state.result.verdict] : '',
);
/** Points ride the verdict anchor — with the in-flow VerdictCard now limited
 *  to open parts, this is the only place the score shows for most kinds. */
const verdictPoints = computed(() => {
  const r = props.state.result;
  return r ? formatScoreRatio(r.awardedPoints, r.maxPoints) : '';
});

const emit = defineEmits<{
  'update:solutionDetent': [detent: SheetDetent];
  /** Forwarded from the sheet so the page can reserve its real height. */
  'update:solutionHeight': [px: number];
  /** Self-assessment mastery pick (only while self-assessing). */
  selfGradingSelect: [grading: Grading];
  /** Rubric ticks / point picks from the panel inside the sheet. */
  assessmentUpdate: [assessment: SelfAssessment];
  /** GradingMenu manual override (any other phase). */
  gradingSelect: [grading: Grading];
  primary: [];
}>();

</script>

<template>
  <div class="practice-bar" :class="{ 'practice-bar--full': solutionDetent === 'full' }">
    <SolutionSheet
      :detent="solutionDetent"
      :solution="solution"
      content-max-width="860px"
      :handle="state.phase !== 'answering'"
      :top-reserve="topReserve"
      :verdict="state.result?.verdict"
      :verdict-label="verdictLabel"
      :verdict-points="verdictPoints"
      class="practice-bar__sheet"
      @update:detent="emit('update:solutionDetent', $event)"
      @update:height="emit('update:solutionHeight', $event)"
    >
      <!-- Judging happens against the solution directly above it, on one
           surface, at full screen. -->
      <template v-if="assessing && state.selfAssessment" #assessment>
        <SelfAssessmentPanel
          :model-value="state.selfAssessment.assessment"
          :scoring="scoring"
          :rubric="rubric"
          :max-points="state.selfAssessment.maxPoints"
          :score-options="state.selfAssessment.scoreOptions"
          @update:model-value="emit('assessmentUpdate', $event)"
        />
        <!-- AI suggestion sits between the criteria and the mastery pick:
             after the thing it comments on, before the thing it informs. -->
        <slot name="assist" />

        <div class="practice-bar__mastery">
          <span class="practice-bar__mastery-label">Bewertung</span>
          <GradingPicker
            :grading="state.selfAssessment.grading"
            @select="emit('selfGradingSelect', $event)"
          />
        </div>
      </template>

      <!-- Forwarded straight through: the bar has no opinion about AI. -->
      <template v-if="$slots.explain" #explain><slot name="explain" /></template>
    </SolutionSheet>

    <div class="practice-bar__row">
      <div class="practice-bar__left">
        <!-- mastery override rides the INFO slot (left), not the action
             cluster — and it shares the Lösung toggle's outlined geometry -->
        <GradingMenu
          v-if="!assessing"
          :grading="grading"
          dense
          class="practice-bar__grading"
          @select="emit('gradingSelect', $event)"
        />
        <div v-if="assessing && state.selfAssessment" class="practice-bar__preview">
          <span class="practice-bar__preview-main">
            <span class="practice-bar__preview-label">Deine Punkte:</span>
            <b class="practice-bar__preview-value">{{ assessedScore }}</b>
          </span>
        </div>
        <div v-else-if="answerPreview" class="practice-bar__preview">
          <span class="practice-bar__preview-main">
            <span class="practice-bar__preview-label">{{ answerPreview.label }}:</span>
            <b class="practice-bar__preview-value">{{ answerPreview.value }}</b>
          </span>
          <span v-if="answerPreview.hint" class="practice-bar__preview-hint">{{ answerPreview.hint }}</span>
        </div>
      </div>

      <div class="practice-bar__right">
        <!-- Hidden on narrow screens: the sheet's grab handle is the control
             there, so this button never has to fight the primary action for
             the last few pixels. -->
        <button
          v-if="state.phase !== 'answering'"
          type="button"
          class="practice-bar__solution-toggle"
          :class="{ 'practice-bar__solution-toggle--on': solutionDetent !== 'collapsed' }"
          :aria-expanded="solutionDetent !== 'collapsed'"
          @click="emit('update:solutionDetent', solutionDetent === 'collapsed' ? 'default' : 'collapsed')"
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
  /* iOS Safari leaves fixed chrome anchored to the layout viewport, i.e.
   * underneath the on-screen keyboard — which would bury the primary action
   * the moment the user starts typing an answer. See useKeyboardInset. */
  bottom: var(--q-keyboard-inset, 0px);
  left: var(--practice-rail-width);
  right: 0;
  z-index: 40;
  background: var(--q-card);
  border-top: 1px solid var(--q-border);
  border-left: 1px solid var(--q-border);
  box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.08);
  transition: box-shadow var(--q-transition-normal);

  /*
   * Hard ceiling, independent of any measurement.
   *
   * The full-screen detent used to be sized purely from JS (viewport minus a
   * reserve minus measured chrome) and any error in that arithmetic put this
   * fixed stack over the practice top bar, hiding the progress segments. The
   * detent maths still picks the target height; THIS is what makes exceeding
   * the available space impossible. The shell publishes its real top bar
   * height; the fallback matches the CSS that bar is written with.
   */
  display: flex;
  flex-direction: column;
  max-height: calc(
    100dvh - var(--practice-topbar-height, calc(56px + env(safe-area-inset-top)))
  );
}

/*
 * Full screen: the bar butts against the practice top bar, which carries its
 * own `border-bottom`. Keeping ours too stacks two hairlines into a grey
 * stripe, and the upward shadow smudges the last few pixels of that bar on
 * top of it — together they read as a gap where there is none (the boxes are
 * flush at 56/56). Nothing scrolls under the bar at this size, so neither
 * declaration is earning anything here.
 */
.practice-bar--full {
  border-top-width: 0;
  box-shadow: none;
}

/* Only the sheet shrinks under the bar's ceiling; the action row keeps its
 * size so the primary button never gets squeezed. */
.practice-bar__sheet {
  min-height: 0;
  flex: 0 1 auto;
}
.practice-bar__row {
  flex: none;
  /*
   * Not redundant with the `auto` margins: the bar is a column flex container,
   * and an auto inline margin cancels `align-items: stretch`, which collapses
   * this row to fit-content — the action cluster then floats centred with dead
   * space either side instead of sitting on the bar's edges. The margins still
   * do the centring once max-width binds on a wide screen.
   */
  width: 100%;
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

/* Mastery pick, under the points panel inside the sheet. */
.practice-bar__mastery {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}
.practice-bar__mastery-label {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--q-faint);
}

.practice-bar__solution-chevron {
  display: inline-block;
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
    /* No wrapping: the row is one line of controls that must all fit, which
     * is what the dense grading capsule and the dropped Lösung button buy. */
    flex-wrap: nowrap;
  }

  /* The sheet's grab handle does this job on a phone — see SolutionSheet. */
  .practice-bar__solution-toggle {
    display: none;
  }
}

@media (max-width: 1023px) {
  .practice-bar {
    left: 0;
    border-left: none;
  }
}
</style>
