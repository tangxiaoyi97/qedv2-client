<script setup lang="ts">
/**
 * Self-assessment (prototype 2e, lower half) — used after submitting `open`
 * parts and for `expression` parts the CAS could not decide.
 *
 * rubric scoring → one checkbox per criterion (its points on the right);
 * anything else → the exact point totals supported by the part's scoring.
 */
import { computed } from 'vue';
import type { RichText, Scoring, SelfAssessment } from '@qed2/core-logic';
import {
  formatScore,
  sameScore,
  selfAssessmentOverallForScore,
  type SelfAssessmentScoreOption,
} from '../practice/self-assessment.js';
import RichTextView from '../shared/RichTextView.vue';
import { onRadioGroupKeydown } from '../shared/radio-group.js';

const props = defineProps<{
  scoring?: Scoring | null;
  rubric?: RichText | null;
  maxPoints: number;
  modelValue: SelfAssessment;
  scoreOptions?: SelfAssessmentScoreOption[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: SelfAssessment] }>();

const rubricMode = computed(() => props.scoring?.mode === 'rubric');
const criteria = computed(() => (props.scoring?.mode === 'rubric' ? props.scoring.criteria : []));
const scoreOptions = computed<SelfAssessmentScoreOption[]>(() =>
  props.scoreOptions && props.scoreOptions.length > 0
    ? props.scoreOptions
    : [
        { points: 0, label: formatScore(0) },
        { points: props.maxPoints, label: formatScore(props.maxPoints) },
      ],
);

const met = computed(() =>
  criteria.value.map((_, i) => props.modelValue.criteriaMet?.[i] === true),
);

const points = computed(() => {
  if (typeof props.modelValue.awardedPoints === 'number' && Number.isFinite(props.modelValue.awardedPoints)) {
    return props.modelValue.awardedPoints;
  }
  if (rubricMode.value) {
    let sum = 0;
    criteria.value.forEach((c, i) => {
      if (met.value[i]) sum += c.points;
    });
    return Math.round(sum * 100) / 100;
  }
  const overall = props.modelValue.overall;
  if (overall === 'full') return props.maxPoints;
  if (overall === 'partial') return Math.round((props.maxPoints / 2) * 100) / 100;
  return 0;
});

function toggleCriterion(i: number): void {
  if (props.disabled) return;
  const next = criteria.value.map((_, j) => (j === i ? !met.value[j] : met.value[j] === true));
  emit('update:modelValue', { ...props.modelValue, criteriaMet: next });
}

function setPoints(value: number): void {
  if (props.disabled) return;
  emit('update:modelValue', {
    ...props.modelValue,
    awardedPoints: value,
    overall: selfAssessmentOverallForScore(value, props.maxPoints),
  });
}

function scoreTone(value: number): 'none' | 'partial' | 'full' {
  const overall = selfAssessmentOverallForScore(value, props.maxPoints);
  return overall === 'none' ? 'none' : overall === 'full' ? 'full' : 'partial';
}

function isSelectedScore(value: number): boolean {
  return sameScore(props.modelValue.awardedPoints, value);
}
</script>

<template>
  <div class="q-selfassess">
    <div class="q-selfassess__head">
      <span class="q-selfassess__title">Selbstbewertung</span>
      <span class="q-selfassess__sub">Vergleiche mit der Lösung</span>
    </div>

    <div v-if="rubric && rubric.length > 0" class="q-selfassess__rubric">
      <div class="q-selfassess__rubric-title">Bewertungsraster</div>
      <RichTextView :nodes="rubric" />
    </div>

    <div v-if="rubricMode" class="q-selfassess__criteria">
      <button
        v-for="(criterion, i) in criteria"
        :key="i"
        type="button"
        class="q-selfassess__criterion"
        :aria-pressed="met[i]"
        :disabled="disabled"
        @click="toggleCriterion(i)"
      >
        <span class="q-selfassess__check" :class="{ 'q-selfassess__check--on': met[i] }" aria-hidden="true">
          <template v-if="met[i]">✓</template>
        </span>
        <span class="q-selfassess__desc">{{ criterion.desc }}</span>
        <span class="q-selfassess__pts">{{ criterion.points }}&nbsp;P</span>
      </button>
    </div>

    <div v-else class="q-selfassess__overall">
      <span class="q-selfassess__overall-label">Meine Punkte:</span>
      <div class="q-selfassess__segments" role="radiogroup" aria-label="Selbstbewertung" @keydown="onRadioGroupKeydown">
        <button
          v-for="option in scoreOptions"
          :key="option.points"
          type="button"
          class="q-selfassess__segment"
          :class="{
            'q-selfassess__segment--on': isSelectedScore(option.points),
            [`q-selfassess__segment--${scoreTone(option.points)}`]: isSelectedScore(option.points),
          }"
          role="radio"
          :aria-checked="isSelectedScore(option.points)"
          :disabled="disabled"
          @click="setPoints(option.points)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <div class="q-selfassess__total">
      <span>Deine Punkte</span>
      <b>{{ points.toLocaleString('de-AT') }} / {{ maxPoints.toLocaleString('de-AT') }}</b>
    </div>
  </div>
</template>

<style scoped>
.q-selfassess {
  padding: 14px;
  background: var(--q-panel-2);
  border-radius: 11px;
}
.q-selfassess__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.q-selfassess__title {
  font-weight: 700;
  font-size: 13px;
}
.q-selfassess__sub {
  font-size: 11.5px;
  color: var(--q-mut-2);
}
.q-selfassess__rubric {
  padding: 11px 13px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  font-size: 12.5px;
  line-height: 1.6;
  margin-bottom: 12px;
}
.q-selfassess__rubric-title {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--q-faint);
  margin-bottom: 6px;
}
.q-selfassess__criteria {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-selfassess__criterion {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  background: var(--q-card);
  border-radius: 9px;
  border: 1px solid var(--q-border);
  cursor: pointer;
  font: inherit;
  color: var(--q-ink);
  text-align: left;
  width: 100%;
}
.q-selfassess__criterion:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 1px;
}
.q-selfassess__check {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--q-check-border);
  display: inline-grid;
  place-items: center;
  font-size: 12px;
  font-weight: 700;
  flex: none;
  box-sizing: border-box;
}
.q-selfassess__check--on {
  border: none;
  background: var(--q-ok);
  color: var(--q-on-ok);
}
.q-selfassess__desc {
  flex: 1;
  font-size: 12.5px;
  min-width: 0;
}
.q-selfassess__pts {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--q-mut-2);
  flex: none;
}
.q-selfassess__overall {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.q-selfassess__overall-label {
  font-size: 12.5px;
  color: var(--q-mut);
}
.q-selfassess__segments {
  display: flex;
  border: 1px solid var(--q-btn-border);
  border-radius: 8px;
  overflow: hidden;
  margin-left: auto;
}
.q-selfassess__segment {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--q-mut-2);
  background: var(--q-card);
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.q-selfassess__segment + .q-selfassess__segment {
  border-left: 1px solid var(--q-btn-border);
}
.q-selfassess__segment--on {
  color: #fff;
  font-weight: 700;
}
.q-selfassess__segment--none {
  background: var(--q-err);
}
.q-selfassess__segment--partial {
  background: var(--q-part);
}
.q-selfassess__segment--full {
  background: var(--q-ok);
}
.q-selfassess__total {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--q-part-bg);
  border: 1px solid var(--q-part-border);
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--q-part-ink);
  font-weight: 600;
}
.q-selfassess__total b {
  font-size: 15px;
  font-weight: 800;
}
</style>
