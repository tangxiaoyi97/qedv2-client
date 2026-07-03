<script setup lang="ts">
/**
 * Kind dispatcher: renders the matching control for an Answer and keeps the
 * external contract a single Submission object (round-tripping the inner
 * value shapes of each control).
 */
import type { Answer, GradeResult, Submission } from '@qed2/core-logic';
import type {
  ChoiceSubmission,
  IntervalSubmission,
  MatchingSubmission,
  NumericSubmission,
  OpenSubmission,
} from '@qed2/core-logic';
import ChoiceControl from './ChoiceControl.vue';
import MatchingControl from './MatchingControl.vue';
import NumericControl from './NumericControl.vue';
import IntervalControl from './IntervalControl.vue';
import ExpressionControl from './ExpressionControl.vue';
import OpenControl from './OpenControl.vue';

const props = defineProps<{
  answer: Answer;
  modelValue: Submission;
  result?: GradeResult | null;
  indeterminate?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: Submission] }>();

function up(value: Submission): void {
  emit('update:modelValue', value);
}
</script>

<template>
  <ChoiceControl
    v-if="answer.kind === 'choice' && modelValue.kind === 'choice'"
    :answer="answer"
    :model-value="(modelValue as ChoiceSubmission).selected"
    :result="result"
    @update:model-value="(v: number[]) => up({ kind: 'choice', selected: v })"
  />
  <MatchingControl
    v-else-if="answer.kind === 'matching' && modelValue.kind === 'matching'"
    :answer="answer"
    :model-value="(modelValue as MatchingSubmission).matches"
    :result="result"
    @update:model-value="(v: (number | null)[]) => up({ kind: 'matching', matches: v })"
  />
  <NumericControl
    v-else-if="answer.kind === 'numeric' && modelValue.kind === 'numeric'"
    :answer="answer"
    :model-value="(modelValue as NumericSubmission).values"
    :result="result"
    @update:model-value="(v: Record<string, string>) => up({ kind: 'numeric', values: v })"
  />
  <IntervalControl
    v-else-if="answer.kind === 'interval' && modelValue.kind === 'interval'"
    :answer="answer"
    :model-value="modelValue as IntervalSubmission"
    :result="result"
    @update:model-value="(v: IntervalSubmission) => up(v)"
  />
  <ExpressionControl
    v-else-if="answer.kind === 'expression' && modelValue.kind === 'expression'"
    :answer="answer"
    :model-value="modelValue.expr"
    :result="result"
    :indeterminate="indeterminate"
    @update:model-value="(v: string) => up({ kind: 'expression', expr: v })"
  />
  <OpenControl
    v-else-if="answer.kind === 'open' && modelValue.kind === 'open'"
    :answer="answer"
    :model-value="modelValue as OpenSubmission"
    :result="result"
    @update:model-value="(v: OpenSubmission) => up(v)"
  />
</template>
