<script setup lang="ts">
import { computed } from 'vue';
import { Sparkles } from 'lucide-vue-next';
import { VERDICT_LABELS, type Grading, type RichText, type Scoring, type SelfAssessment, type SolutionEntry } from '@qed2/core-logic';
import { useI18n } from '../i18n.js';
import type { PartPlayerState } from './part-player-types.js';
import { formatUiScoreRatio } from '../shared/format-score.js';
import GradingPicker from '../shared/GradingPicker.vue';
import StateIcon from '../shared/StateIcon.vue';
import RichTextView from '../shared/RichTextView.vue';
import SelfAssessmentPanel from '../question/SelfAssessmentPanel.vue';
import SolutionPanel from './SolutionPanel.vue';

const props = defineProps<{
  state: PartPlayerState;
  solution?: SolutionEntry[];
  scoring?: Scoring | null;
  rubric?: RichText | null;
  ready: boolean;
  submissionUnavailable?: boolean;
  disabled?: boolean;
  assistAvailable?: boolean;
}>();
const emit = defineEmits<{
  assessmentUpdate: [value: SelfAssessment];
  gradingSelect: [value: Grading];
  assist: [];
}>();
const { t } = useI18n();
const result = computed(() => props.state.result);
// Interval previews retain open/closed and unbounded endpoints, unlike the AI text projection.
const answerText = computed(() => props.state.answerPreview?.value ?? props.state.submittedText);
</script>

<template>
  <div class="practice-review">
    <div v-if="result" class="practice-review__result" :class="`practice-review__result--${result.verdict}`" role="status">
      <StateIcon :state="result.verdict" :size="22" />
      <strong>{{ t(VERDICT_LABELS[result.verdict]) }}</strong>
      <span>{{ formatUiScoreRatio(result.awardedPoints, result.maxPoints) }}</span>
    </div>

    <section class="practice-review__answer" :aria-label="t('Meine Antwort')">
      <h2>{{ t('Meine Antwort') }}</h2>
      <p v-if="submissionUnavailable" class="practice-review__empty" role="status">{{ t('Deine gespeicherte Antwort ist auf diesem Gerät nicht verfügbar.') }}</p>
      <p v-else-if="answerText.trim()" class="practice-review__submitted">{{ answerText }}</p>
      <p v-else class="practice-review__empty">{{ t('Keine schriftliche Antwort') }}</p>
    </section>

    <template v-if="ready">
      <section class="practice-review__solution" :aria-label="t('Offizieller Lösungsweg')">
        <h2>{{ t('Offizieller Lösungsweg') }}</h2>
        <SolutionPanel :solution="solution" plain />
        <p v-if="!solution?.length" class="practice-review__empty">{{ t('Keine offizielle Lösung verfügbar.') }}</p>
      </section>

      <section v-if="state.phase === 'self-assessing' && state.selfAssessment" class="practice-review__assessment" :aria-label="t('Selbstbewertung')">
        <details v-if="rubric?.length" class="practice-review__rubric">
          <summary>{{ t('Bewertungsraster') }}</summary>
          <RichTextView :nodes="rubric" />
        </details>
        <SelfAssessmentPanel
          :model-value="state.selfAssessment.assessment"
          :scoring="scoring"
          :max-points="state.selfAssessment.maxPoints"
          :selected-points="state.selfAssessment.selectedPoints"
          :score-options="state.selfAssessment.scoreOptions"
          :disabled="disabled"
          @update:model-value="emit('assessmentUpdate', $event)"
        />
        <div class="practice-review__mastery">
          <h3>{{ t('Wie sicher warst du?') }}</h3>
          <GradingPicker :grading="state.selfAssessment.grading" :disabled="disabled" :label="t('Wie sicher warst du?')" @select="emit('gradingSelect', $event)" />
        </div>
        <button v-if="assistAvailable" type="button" class="practice-review__assist" :disabled="disabled" @click="emit('assist')">
          <Sparkles :size="16" aria-hidden="true" />{{ t('Mit KI vergleichen') }}
        </button>
      </section>
    </template>
    <p v-else class="practice-review__empty" role="status">{{ t('Antwort wird gesichert …') }}</p>
  </div>
</template>

<style scoped>
.practice-review { display: flex; flex-direction: column; gap: 28px; }
.practice-review h2 { margin: 0 0 12px; color: var(--q-ink); font-size: 15px; font-weight: 750; }
.practice-review__result { display: flex; align-items: center; gap: 9px; font-size: 15px; }
.practice-review__result span { margin-left: auto; font-size: 13px; font-variant-numeric: tabular-nums; }
.practice-review__result--correct { color: var(--q-ok-ink); }
.practice-review__result--partial { color: var(--q-part-ink); }
.practice-review__result--incorrect { color: var(--q-err-ink); }
.practice-review__answer { padding-bottom: 24px; border-bottom: 1px solid var(--q-border-soft); }
.practice-review__answer h2 { color: var(--q-faint); font-size: 12px; }
.practice-review__submitted { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.7; }
.practice-review__empty { margin: 0; color: var(--q-faint); font-size: 13px; }
.practice-review__assessment { padding-top: 24px; border-top: 1px solid var(--q-border-soft); }
.practice-review__rubric { color: var(--q-mut); font-size: 13px; line-height: 1.7; margin-bottom: 16px; }
.practice-review__rubric summary { cursor: pointer; padding: 8px 0; }
.practice-review__mastery { margin-top: 22px; }
.practice-review__mastery h3 { font-size: 13px; font-weight: 650; margin: 0 0 10px; }
.practice-review__assist { display: inline-flex; align-items: center; gap: 7px; padding: 8px 0; margin-top: 16px; border: none; background: none; color: var(--q-accent-strong); font: inherit; font-size: 13px; font-weight: 650; min-height: 44px; cursor: pointer; }
.practice-review__assist:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 4px; border-radius: 4px; }
.practice-review :deep(.q-selfassess) { padding: 0; background: none; border-radius: 0; }
.practice-review :deep(.q-selfassess__title) { font-size: 15px; }
.practice-review :deep(.q-selfassess__segments) { margin-left: 0; }
.practice-review :deep(.q-selfassess__segment) { min-width: 64px; min-height: 44px; font-size: 15px; }
.practice-review :deep(.q-selfassess__total) { padding: 10px 0 0; background: none; border: none; color: var(--q-mut); font-weight: 500; }
.practice-review :deep(.q-gpick__opt) { border-color: transparent; background: var(--q-panel); box-shadow: none; }
.practice-review :deep(.q-gpick__opt--on) { background: var(--q-accent-bg); border-color: var(--q-accent); }
.practice-review :deep(.q-selfassess__criterion) { min-height: 44px; background: none; border-color: var(--q-border-soft); }
</style>
