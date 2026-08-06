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
import type { GradeResult, Submission } from '../grading/types.js';
import type { Answer, Figure, Question, QuestionPart, RubricScoring } from '../model/question.js';
import { isRichTextEmpty, richTextToPlain } from '../model/richtext.js';
import type { FigNode, RichText } from '../model/richtext.js';
import type {
  AiAssessRequest,
  AiExplainMode,
  AiExplainRequest,
  AiPromptOptions,
  AiRubricCriterion,
} from './types.js';

/**
 * Alt text of every figure attached to the question or the part.
 *
 * The array being non-empty is the signal that the model is working blind:
 * SRDP questions lean on function graphs and geometry diagrams, and the server
 * cannot fetch them (that would mean calling core). Callers use this to soften
 * the explanation and to refuse pre-filling a grade entirely.
 */
function answerRichTexts(answer: Answer | undefined): RichText[] {
  if (!answer) return [];
  switch (answer.kind) {
    case 'choice':
      return answer.options;
    case 'matching':
      return [
        ...answer.left,
        ...answer.right,
        ...(answer.candidateGroups ?? []).flatMap((group) => (group.label ? [group.label] : [])),
      ];
    case 'open':
      return [answer.rubric];
    default:
      return [];
  }
}

function inlineFigures(text: RichText | undefined): FigNode[] {
  return (text ?? []).filter((node): node is FigNode => node.t === 'fig');
}

function allFigures(question: Question, part: QuestionPart): (Figure | FigNode)[] {
  const solution = part.solution ?? [];
  const richTexts = [
    question.prompt,
    part.prompt,
    ...answerRichTexts(part.answer),
    ...solution.map((entry) => entry.result),
  ];
  return [
    ...(question.figures ?? []),
    ...(part.figures ?? []),
    ...solution.flatMap((entry) => entry.figures ?? []),
    ...richTexts.flatMap((text) => inlineFigures(text)),
  ];
}

function altOf(figure: Figure | FigNode): string {
  return 'alt' in figure && typeof figure.alt === 'string' ? figure.alt.trim() : '';
}

export function figureAlts(question: Question, part: QuestionPart): string[] {
  return [...new Set(allFigures(question, part).map(altOf).filter(Boolean))];
}

export function hasFigures(question: Question, part: QuestionPart): boolean {
  return allFigures(question, part).length > 0;
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
  const includesFigures = hasFigures(question, part);
  const questionPrompt = richTextToPlain(question.prompt);
  const partPrompt = richTextToPlain(part.prompt);
  return {
    questionId: question.id,
    partId: part.id,
    ...(questionPrompt ? { questionPrompt } : {}),
    ...(partPrompt ? { partPrompt } : {}),
    ...(part.format ? { format: part.format } : {}),
    ...(alts.length > 0 ? { figureAlts: alts } : {}),
    ...(includesFigures ? { hasFigures: true } : {}),
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
  /** `walkthrough` explains the question itself rather than the answer. */
  mode?: AiExplainMode;
  options?: AiPromptOptions;
}): AiExplainRequest {
  const { question, part, submitted, result } = input;
  return {
    ...shared(question, part, submitted, result.maxPoints),
    ...promptOptions(input.options),
    ...(input.mode && input.mode !== 'answer' ? { mode: input.mode } : {}),
    verdict: result.verdict,
    awardedPoints: result.awardedPoints,
  };
}

/** Drop empty preferences rather than sending blanks the server must ignore. */
export function promptOptions(options: AiPromptOptions | undefined): AiPromptOptions {
  const out: AiPromptOptions = {};
  const language = options?.language?.trim();
  const custom = options?.customInstructions?.trim();
  if (language) out.language = language;
  if (custom) out.customInstructions = custom;
  // Both values are billing instructions in v2: false explicitly requires
  // BYO, while an omitted field lets the server choose its automatic default.
  if (options?.preferPool !== undefined) out.preferPool = options.preferPool;
  return out;
}

/**
 * Build an assessment request, or `null` when this part must not be judged by
 * an AI at all.
 *
 * Which shape comes back depends on the scoring: rubric parts get `criteria`
 * (one verdict each), everything else gets `scoreOptions` (one decision from
 * the values the part allows). In the bank as it stands that split is roughly
 * two thirds / one third, so refusing the non-rubric ones would leave a large
 * slice of AI-marked questions with no help at all.
 *
 * Gates: the bank must say `grader: 'ai'`, and the answer must not be empty —
 * there is nothing to evidence a verdict with.
 */
export function buildAssessRequest(input: {
  question: Question;
  part: QuestionPart;
  submitted: string;
  maxPoints: number;
  /** Point values the part permits — required for non-rubric scoring. */
  scoreOptions?: number[];
  options?: AiPromptOptions;
}): AiAssessRequest | null {
  const { question, part, submitted, maxPoints } = input;
  if (!isAiGradable(part)) return null;
  if (!submitted.trim()) return null;

  const base = { ...shared(question, part, submitted, maxPoints), ...promptOptions(input.options) };
  const answer = part.answer;
  const rubricText =
    answer?.kind === 'open' && !isRichTextEmpty(answer.rubric)
      ? richTextToPlain(answer.rubric)
      : undefined;

  if (part.scoring?.mode === 'rubric') {
    const criteria = rubricCriteria(part.scoring);
    if (criteria.length > 0) return { ...base, criteria };
  }

  // No scored criteria: judge the answer as a whole against the values the
  // part allows. Two thirds of AI-eligible open parts are rubric; the rest
  // are all-or-nothing or tiered and would otherwise get no help at all.
  const options = (input.scoreOptions ?? []).filter((n) => Number.isFinite(n));
  if (options.length < 2) return null;
  return { ...base, scoreOptions: [...new Set(options)].sort((a, b) => a - b), ...(rubricText ? { rubricText } : {}) };
}

export function rubricCriteria(scoring: RubricScoring): AiRubricCriterion[] {
  return scoring.criteria.map((c, index) => ({ index, desc: c.desc, points: c.points }));
}

/**
 * Whether the bank allows an AI verdict on this part.
 *
 * `grader` is per-question metadata that has existed since v1 — the content
 * side decides, and the client obeys it.
 */
export function isAiGradable(part: QuestionPart): boolean {
  const answer: Answer | undefined = part.answer;
  if (!answer || answer.kind !== 'open') return false;
  // The bank decides, per question. Scoring mode does NOT gate this any more:
  // rubric parts get per-criterion verdicts, the rest get one overall score.
  return answer.grader === 'ai';
}

/**
 * The student's answer as plain text, for an AI prompt.
 *
 * NOT `answerPreview`: that is a UI affordance and returns null for every kind
 * except `interval`, so using it silently sent an empty answer for every open
 * question — the model was being asked to explain nothing at all.
 *
 * Only the kinds a human writes in prose are worth sending. Choice and
 * matching are graded deterministically and never reach an AI.
 */
export function submittedText(
  submission: Submission | null | undefined,
  answer?: Answer | undefined,
): string {
  if (!submission) return '';
  switch (submission.kind) {
    case 'open':
      return submission.text.trim();
    case 'expression':
      return submission.expr.trim();
    case 'choice':
      // Indices alone say nothing. Ask a model why "1, 3" is wrong and it can
      // only shrug — the real Gemini reply to a choice question was "no answer
      // was given". So resolve them against the option texts.
      return answer?.kind === 'choice'
        ? submission.selected
            .map((i) => `${String.fromCharCode(65 + i)}) ${richTextToPlain(answer.options[i])}`)
            .filter(Boolean)
            .join('\n')
        : submission.selected.map((i) => String.fromCharCode(65 + i)).join(', ');
    case 'matching':
      // Pair indices are as opaque to a model as choice indices were. Resolve
      // both sides so an explanation can name what was matched to what.
      return answer?.kind === 'matching'
        ? submission.matches
            .map((right, left) =>
              right === null
                ? null
                : `${richTextToPlain(answer.left[left])} → ${richTextToPlain(answer.right[right])}`,
            )
            .filter((line): line is string => Boolean(line))
            .join('\n')
        : '';
    case 'interval':
      return [submission.lower, submission.upper]
        .map((v) => (v ?? '').toString().trim())
        .filter(Boolean)
        .join(' … ');
    case 'numeric':
      // Blank id → raw input. Join in a stable order so the same answer always
      // produces the same prompt, and therefore the same cache key.
      return Object.keys(submission.values)
        .sort()
        .map((k) => submission.values[k]?.trim() ?? '')
        .filter(Boolean)
        .join(' · ');
    default:
      return '';
  }
}
