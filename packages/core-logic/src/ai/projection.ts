/**
 * Turning a rendered question into an AI request payload.
 *
 * This is the client half of "the client is the only middleman": qed2-server
 * never calls qed2-core, so every scrap of question material an AI needs has
 * to be projected here, out of the `Question` the client already fetched to
 * render the screen.
 *
 * Pure on purpose — no network, no store, no Vue. The rules about what may be
 * sent, and when AI must not be offered at all, are exactly the kind of thing
 * that has to be testable without a browser.
 */
import type { GradeResult } from '../grading/types.js';
import type { Answer, Question, QuestionPart, RubricScoring } from '../model/question.js';
import { isRichTextEmpty, richTextToPlain } from '../model/richtext.js';
import type { AiAssessRequest, AiExplainRequest, AiRubricCriterion } from './types.js';

/**
 * Alt text of every figure attached to the question or the part.
 *
 * The array being non-empty is the signal that the model is working blind:
 * SRDP questions lean on function graphs and geometry diagrams, and the server
 * cannot fetch them (that would mean calling core). Callers use this to soften
 * the explanation and to refuse pre-filling a grade entirely.
 */
export function figureAlts(question: Question, part: QuestionPart): string[] {
  const figures = [...(question.figures ?? []), ...(part.figures ?? [])];
  return figures.map((f) => (typeof f.alt === 'string' ? f.alt.trim() : '')).filter(Boolean);
}

export function hasFigures(question: Question, part: QuestionPart): boolean {
  return [...(question.figures ?? []), ...(part.figures ?? [])].length > 0;
}

/** First solution entry's text, plus its grading note, as plain text. */
function solutionText(part: QuestionPart): { officialSolution?: string; gradingNote?: string } {
  const entry = part.solution?.[0];
  if (!entry) return {};
  const out: { officialSolution?: string; gradingNote?: string } = {};
  if (!isRichTextEmpty(entry.result)) out.officialSolution = richTextToPlain(entry.result);
  if (entry.note?.trim()) out.gradingNote = entry.note.trim();
  return out;
}

function shared(question: Question, part: QuestionPart, submitted: string, maxPoints: number) {
  const alts = figureAlts(question, part);
  const questionPrompt = richTextToPlain(question.prompt);
  const partPrompt = richTextToPlain(part.prompt);
  return {
    questionId: question.id,
    partId: part.id,
    ...(questionPrompt ? { questionPrompt } : {}),
    ...(partPrompt ? { partPrompt } : {}),
    ...(part.format ? { format: part.format } : {}),
    ...(alts.length > 0 ? { figureAlts: alts } : {}),
    submitted,
    ...solutionText(part),
    maxPoints,
  };
}

/**
 * Build an explanation request.
 *
 * `submitted` is the answer as the user would read it back — the caller passes
 * the same projection the answer preview shows, because that is what the
 * explanation has to talk about.
 */
export function buildExplainRequest(input: {
  question: Question;
  part: QuestionPart;
  submitted: string;
  result: GradeResult;
}): AiExplainRequest {
  const { question, part, submitted, result } = input;
  return {
    ...shared(question, part, submitted, result.maxPoints),
    verdict: result.verdict,
    awardedPoints: result.awardedPoints,
  };
}

/**
 * Build a rubric-assessment request, or `null` when this part must not be
 * assessed by an AI at all.
 *
 * Three gates, all of them deliberate:
 *  - the bank must mark the part `grader: 'ai'`,
 *  - the scoring must be rubric mode (no criteria, no reliable judgement),
 *  - the answer must not be empty (nothing to evidence a criterion with).
 */
export function buildAssessRequest(input: {
  question: Question;
  part: QuestionPart;
  submitted: string;
  maxPoints: number;
}): AiAssessRequest | null {
  const { question, part, submitted, maxPoints } = input;
  if (!isAiGradable(part)) return null;
  if (!submitted.trim()) return null;

  const criteria = rubricCriteria(part.scoring as RubricScoring);
  if (criteria.length === 0) return null;

  return { ...shared(question, part, submitted, maxPoints), criteria };
}

export function rubricCriteria(scoring: RubricScoring): AiRubricCriterion[] {
  return scoring.criteria.map((c, index) => ({ index, desc: c.desc, points: c.points }));
}

/**
 * Whether the bank and the scoring both allow an AI verdict on this part.
 *
 * `grader` is per-question metadata that has existed since v1 — the bank
 * decides which questions have a rubric good enough to judge against, and the
 * client obeys it.
 */
export function isAiGradable(part: QuestionPart): boolean {
  const answer: Answer | undefined = part.answer;
  if (!answer || answer.kind !== 'open') return false;
  if (answer.grader !== 'ai') return false;
  return part.scoring?.mode === 'rubric';
}
