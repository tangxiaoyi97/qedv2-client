// shared foundation
export { default as MathText } from './shared/MathText.vue';
export { default as RichTextView } from './shared/RichTextView.vue';
export { default as StateIcon } from './shared/StateIcon.vue';
export { default as QButton } from './shared/QButton.vue';
export { default as QChip } from './shared/QChip.vue';
export { default as CollapsePanel } from './shared/CollapsePanel.vue';
export * from './shared/assets.js';

// grading system (grading supplement)
export { default as GradingDot } from './shared/GradingDot.vue';
export { default as GradingCapsule } from './shared/GradingCapsule.vue';
export { default as GradingMenu } from './shared/GradingMenu.vue';
export { default as StarButton } from './shared/StarButton.vue';

// search (search upgrade doc)
export { default as SearchBox } from './shared/SearchBox.vue';
export { default as HighlightSnippet } from './shared/HighlightSnippet.vue';

// question rendering + answer controls
export { default as ChoiceControl } from './question/ChoiceControl.vue';
export { default as MatchingControl } from './question/MatchingControl.vue';
export { default as NumericControl } from './question/NumericControl.vue';
export { default as IntervalControl } from './question/IntervalControl.vue';
export { default as ExpressionControl } from './question/ExpressionControl.vue';
export { default as OpenControl } from './question/OpenControl.vue';
export { default as AnswerControl } from './question/AnswerControl.vue';
export { default as SelfAssessmentPanel } from './question/SelfAssessmentPanel.vue';

// practice flow
export { default as ResultBanner } from './practice/ResultBanner.vue';
export { default as ResultPill } from './practice/ResultPill.vue';
export { default as SolutionPanel } from './practice/SolutionPanel.vue';
export { default as SolutionSheet } from './practice/SolutionSheet.vue';
export { default as PartPlayer } from './practice/PartPlayer.vue';
export type { PartPlayerState } from './practice/part-player-types.js';
export { default as QuestionHeader } from './practice/QuestionHeader.vue';

// review / progress
export { default as MasteryBar } from './review/MasteryBar.vue';
export { default as CompetencyGroups } from './review/CompetencyGroups.vue';
export { default as ActivityHeatmap } from './review/ActivityHeatmap.vue';
export { default as GradingDistribution } from './review/GradingDistribution.vue';
export { default as RadarChart } from './review/RadarChart.vue';
export type { RadarAxis } from './review/RadarChart.vue';

export * from './question/submission-defaults.js';
