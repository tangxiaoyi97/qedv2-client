import type { GradeResult, Grading, QuestionPart, Scoring, SelfAssessment } from '@qed2/core-logic';

const EPS = 1e-9;

export interface SelfAssessmentScoreOption {
  points: number;
  label: string;
}

export interface SelfAssessmentUiState {
  maxPoints: number;
  scoreOptions: SelfAssessmentScoreOption[];
  selectedPoints: number | null;
  grading: Grading | null;
  /** Full rubric/overall selection so a chromeless shell can render it. */
  assessment: SelfAssessment;
}

export interface SelfAssessmentGradingOption {
  grading: Grading;
  label: string;
  hint: string;
}

export const SELF_ASSESSMENT_GRADING_OPTIONS: readonly SelfAssessmentGradingOption[] = [
  { grading: 'good', label: 'Gut', hint: 'Gemeistert' },
  { grading: 'careless', label: 'Schlampigkeitsfehler', hint: 'Eigentlich gekonnt' },
  { grading: 'meh', label: 'Halb verstanden', hint: 'Bald wiederholen' },
  { grading: 'baffled', label: 'Keine Ahnung', hint: 'Von vorn' },
  { grading: 'excluded', label: 'Ausgeschlossen', hint: 'Nie wieder üben' },
];

export function sameScore(a: number | null | undefined, b: number): boolean {
  return typeof a === 'number' && Math.abs(a - b) <= EPS;
}

export function roundScore(points: number): number {
  return Math.round(points * 100) / 100;
}

export function formatScore(points: number): string {
  const rounded = roundScore(points);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

export function maxPointsForScoring(scoring: Scoring | undefined, fallbackPoints: number | undefined): number {
  if (scoring === undefined) return fallbackPoints ?? 1;
  switch (scoring.mode) {
    case 'allOrNothing':
      return scoring.points;
    case 'perBlank':
      return scoring.max;
    case 'tiered':
      return scoring.tiers.reduce((max, tier) => Math.max(max, tier.points), 0);
    case 'rubric':
      return scoring.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  }
}

function normalizeOptions(points: Iterable<number>, maxPoints: number): SelfAssessmentScoreOption[] {
  const normalized = [...new Set([...points, 0, maxPoints].map((p) => roundScore(p)))]
    .filter((p) => Number.isFinite(p) && p >= 0 && p <= maxPoints + EPS)
    .sort((a, b) => a - b);
  return normalized.map((pointsValue) => ({ points: pointsValue, label: formatScore(pointsValue) }));
}

function perBlankOptions(scoring: Extract<Scoring, { mode: 'perBlank' }>): number[] {
  if (scoring.pointsPerCorrect <= 0 || scoring.max <= 0) return [0, scoring.max];
  const options = [0];
  for (let p = scoring.pointsPerCorrect; p < scoring.max - EPS; p += scoring.pointsPerCorrect) {
    options.push(roundScore(p));
  }
  options.push(scoring.max);
  return options;
}

function rubricOptions(scoring: Extract<Scoring, { mode: 'rubric' }>): number[] {
  const sums = new Set<number>([0]);
  for (const criterion of scoring.criteria) {
    const current = [...sums];
    for (const sum of current) sums.add(roundScore(sum + criterion.points));
  }
  return [...sums];
}

export function scoreOptionsForPart(part: QuestionPart, indeterminateMax?: number): SelfAssessmentScoreOption[] {
  const maxPoints = indeterminateMax ?? maxPointsForScoring(part.scoring, part.points);
  const scoring = part.scoring;
  if (scoring === undefined) return normalizeOptions([0, maxPoints], maxPoints);

  switch (scoring.mode) {
    case 'allOrNothing':
      return normalizeOptions([0, scoring.points], maxPoints);
    case 'perBlank':
      return normalizeOptions(perBlankOptions(scoring), maxPoints);
    case 'tiered':
      return normalizeOptions(scoring.tiers.map((tier) => tier.points), maxPoints);
    case 'rubric':
      return normalizeOptions(rubricOptions(scoring), maxPoints);
  }
}

export function selfAssessmentOverallForScore(points: number, maxPoints: number): SelfAssessment['overall'] {
  if (points <= EPS) return 'none';
  if (points >= maxPoints - EPS) return 'full';
  return 'partial';
}

export function defaultGradingForScore(points: number, maxPoints: number): Grading {
  if (points >= maxPoints - EPS) return 'good';
  if (points <= EPS) return 'baffled';
  return 'meh';
}

export function gradeResultFromScore(points: number, maxPoints: number): GradeResult {
  const awardedPoints = roundScore(Math.min(Math.max(points, 0), maxPoints));
  const verdict = awardedPoints >= maxPoints - EPS ? 'correct' : awardedPoints > EPS ? 'partial' : 'incorrect';
  return { verdict, correct: verdict === 'correct', awardedPoints, maxPoints };
}

export function selectedPointsFromAssessment(
  assessment: SelfAssessment,
  maxPoints: number,
  scoring?: Scoring,
): number | null {
  if (scoring?.mode === 'rubric' && assessment.criteriaMet) {
    const total = scoring.criteria.reduce(
      (sum, criterion, index) => sum + (assessment.criteriaMet?.[index] === true ? criterion.points : 0),
      0,
    );
    return roundScore(Math.min(Math.max(total, 0), maxPoints));
  }
  if (typeof assessment.awardedPoints === 'number' && Number.isFinite(assessment.awardedPoints)) {
    return roundScore(assessment.awardedPoints);
  }
  if (assessment.overall === 'full') return maxPoints;
  if (assessment.overall === 'partial') return roundScore(maxPoints / 2);
  if (assessment.overall === 'none') return 0;
  return null;
}
