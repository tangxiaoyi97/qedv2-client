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
  AiQuestionContext,
  AiRequestContext,
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
      // A rubric is official judgement material, not something the learner
      // sees before answering. Its figures belong to the protected side.
      return [];
    default:
      return [];
  }
}

function inlineFigures(text: RichText | undefined): FigNode[] {
  return (text ?? []).filter((node): node is FigNode => node.t === 'fig');
}

function promptFigures(question: Question, part: QuestionPart): (Figure | FigNode)[] {
  const richTexts = [
    question.prompt,
    part.prompt,
    ...answerRichTexts(part.answer),
  ];
  return [
    ...(question.figures ?? []),
    ...(part.figures ?? []),
    ...richTexts.flatMap((text) => inlineFigures(text)),
  ];
}

function solutionFigures(part: QuestionPart): (Figure | FigNode)[] {
  const solution = part.solution ?? [];
  const richTexts = [
    ...solution.flatMap((entry) => [
      entry.steps,
      entry.result,
      ...(entry.alternatives ?? []),
    ]),
  ];
  return [
    ...solution.flatMap((entry) => entry.figures ?? []),
    ...richTexts.flatMap((text) => inlineFigures(text)),
    ...(part.answer?.kind === 'open' ? inlineFigures(part.answer.rubric) : []),
  ];
}

function allFigures(question: Question, part: QuestionPart): (Figure | FigNode)[] {
  return [...promptFigures(question, part), ...solutionFigures(part)];
}

function altOf(figure: Figure | FigNode): string {
  return 'alt' in figure && typeof figure.alt === 'string' ? figure.alt.trim() : '';
}

export function figureAlts(question: Question, part: QuestionPart): string[] {
  // Solution alt text often contains the numeric answer. It belongs to the
  // protected official solution, never to the ordinary blind-figure context.
  return [...new Set(promptFigures(question, part).map(altOf).filter(Boolean))];
}

export function hasFigures(question: Question, part: QuestionPart): boolean {
  return allFigures(question, part).length > 0;
}

export function hasSolutionFigures(part: QuestionPart): boolean {
  return solutionFigures(part).length > 0;
}

/** Complete, ordered official material; never silently drops steps-only rows. */
function solutionText(part: QuestionPart): Pick<AiQuestionContext, 'officialSolution' | 'solution' | 'gradingNote'> {
  const entries = part.solution ?? [];
  if (entries.length === 0) return {};
  const first = entries[0];
  const steps = entries.flatMap((entry) => {
    if (isRichTextEmpty(entry.steps)) return [];
    const text = richTextToPlain(entry.steps);
    if (!text) return [];
    return [{ ...(entry.id ? { id: entry.id } : {}), text }];
  });
  const firstResult = first && !isRichTextEmpty(first.result)
    ? richTextToPlain(first.result)
    : undefined;
  const alternatives = entries.flatMap((entry, index) => [
    ...(index > 0 && !isRichTextEmpty(entry.result) ? [richTextToPlain(entry.result)] : []),
    ...(entry.alternatives ?? []).map((text) => richTextToPlain(text)),
  ]).filter(Boolean);
  const officialParts = entries.flatMap((entry) => [entry.steps, entry.result, ...(entry.alternatives ?? [])])
    .filter((text): text is RichText => !isRichTextEmpty(text))
    .map((text) => richTextToPlain(text))
    .filter(Boolean);
  const gradingNote = entries.map((entry) => entry.note?.trim()).find(Boolean);
  const structured: NonNullable<AiQuestionContext['solution']> = {};
  if (firstResult) structured.result = firstResult;
  if (steps.length > 0) structured.steps = steps;
  if (alternatives.length > 0) structured.alternatives = alternatives;
  const out: Pick<AiQuestionContext, 'officialSolution' | 'solution' | 'gradingNote'> = {};
  if (officialParts.length > 0) out.officialSolution = officialParts.join('\n\n');
  if (Object.keys(structured).length > 0) out.solution = structured;
  if (gradingNote) out.gradingNote = gradingNote;
  return out;
}

/**
 * Last client-side safety net for first-attempt hints.
 *
 * The official answer deliberately never enters the provider prompt before a
 * real attempt. That also means the server cannot compare a surprisingly
 * complete model reply with the answer it must not see. The renderer still
 * has the immutable Bank part, so it performs this conservative comparison
 * before a paid reply is cached, shown, or counted as a delivered hint.
 */
export function hintRevealsOfficialSolution(markdown: string, part: QuestionPart): boolean {
  const shown = normalizeProtectedAnswer(markdown);
  if (!shown) return false;
  const compactShown = compactProtectedAnswer(shown);
  const protectedAnswers = new Set<string>();
  for (const entry of part.solution ?? []) {
    addProtected(protectedAnswers, entry.result);
    for (const alternative of entry.alternatives ?? []) addProtected(protectedAnswers, alternative);
    if (!isRichTextEmpty(entry.steps)) {
      const steps = richTextToPlain(entry.steps);
      addProtectedText(protectedAnswers, steps);
      // A v2/v3 steps-only solution can be one prose block. Its final clause
      // is the answer even when there is no separate `result` node.
      const clauses = steps.split(/(?:\r?\n|[.;](?=\s|$)|\b(?:also|somit|daher|folglich)\b)/iu);
      addProtectedText(protectedAnswers, clauses.at(-1) ?? '');
    }
    if (entry.note) addProtectedText(protectedAnswers, entry.note);
  }
  addAnswerProtected(protectedAnswers, part.answer);
  const legacy = solutionText(part).officialSolution;
  if (legacy) addProtectedText(protectedAnswers, legacy);
  return [...protectedAnswers].some((answer) =>
    containsProtectedAnswer(shown, answer)
    || containsProtectedAnswer(compactShown, compactProtectedAnswer(answer)));
}

function addAnswerProtected(target: Set<string>, answer: Answer | undefined): void {
  if (!answer || answer.kind === 'open') return;
  switch (answer.kind) {
    case 'numeric':
      for (const blank of answer.blanks) {
        addProtectedText(target, String(blank.value));
        if (blank.unit) addProtectedText(target, `${blank.value} ${blank.unit}`);
      }
      return;
    case 'expression':
      addProtectedText(target, answer.canonical);
      return;
    case 'interval': {
      const lower = answer.lower == null ? '-∞' : String(answer.lower);
      const upper = answer.upper == null ? '∞' : String(answer.upper);
      const left = answer.lowerClosed ? '[' : ']';
      const right = answer.upperClosed ? ']' : '[';
      addProtectedText(target, `${left}${lower}; ${upper}${right}`);
      addProtectedText(target, `${lower} … ${upper}`);
      return;
    }
    case 'choice': {
      const correct = answer.correct
        .map((index) => richTextToPlain(answer.options[index]))
        .filter(Boolean);
      for (const option of correct) addProtectedText(target, option);
      if (correct.length > 1) addProtectedText(target, correct.join(' / '));
      return;
    }
    case 'matching': {
      const pairs = answer.pairs.map(([left, right]) =>
        `${richTextToPlain(answer.left[left])} → ${richTextToPlain(answer.right[right])}`);
      for (const pair of pairs) addProtectedText(target, pair);
      if (pairs.length > 1) addProtectedText(target, pairs.join(' / '));
    }
  }
}

function addProtected(target: Set<string>, text: RichText | undefined): void {
  if (!isRichTextEmpty(text)) addProtectedText(target, richTextToPlain(text));
}

function addProtectedText(target: Set<string>, text: string): void {
  const normalized = normalizeProtectedAnswer(text);
  if (!normalized) return;
  target.add(normalized);
  // `x = 4`, `x=4`, and a model spelling out just `4` are the same leaked
  // final answer. Keep the right-hand side as a separate protected candidate.
  const rhs = normalized.split(/(?:=|≈|≃|\b(?:ist|ergibt)\b)/u).at(-1)?.trim();
  if (rhs && rhs !== normalized) target.add(rhs);
}

function compactProtectedAnswer(value: string): string {
  return value.replace(/\s+/gu, '');
}

function normalizeProtectedAnswer(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('de')
    .replace(/(?<=\d)\s*(?:\{,\}|,)\s*(?=\d)/gu, '.')
    .replace(/\\(?:left|right|mathrm|text|operatorname)\b/gu, '')
    .replace(/\\(?:cdot|times)\b/gu, '*')
    .replace(/[·⋅×]/gu, '*')
    .replace(/\\(?:infty)\b/gu, '∞')
    .replace(/[{}$]/gu, '')
    .replace(/[`*_~#>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function containsProtectedAnswer(shown: string, answer: string): boolean {
  if (!answer) return false;
  let from = 0;
  while (from <= shown.length - answer.length) {
    const index = shown.indexOf(answer, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : shown[index - 1] ?? '';
    const afterIndex = index + answer.length;
    const after = afterIndex >= shown.length ? '' : shown[afterIndex] ?? '';
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    from = index + 1;
  }
  return false;
}

function shared(
  question: Question,
  part: QuestionPart,
  submitted: string,
  maxPoints: number,
  includeSolution = true,
) {
  const alts = figureAlts(question, part);
  const includesFigures = hasFigures(question, part);
  const solutionIncludesFigures = hasSolutionFigures(part);
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
    solutionHasFigures: solutionIncludesFigures,
    submitted,
    ...(includeSolution ? solutionText(part) : {}),
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
  /** Omitted only for a pre-attempt hint. */
  result?: GradeResult;
  /** `walkthrough` explains the question itself rather than the answer. */
  mode?: AiExplainMode;
  options?: AiPromptOptions;
  identity?: AiRequestContext;
  hintLevel?: 1 | 2 | 3;
}): AiExplainRequest {
  const { question, part, submitted, result } = input;
  const mode = input.mode ?? 'answer';
  if (mode === 'hint' && input.hintLevel == null) {
    throw new TypeError('A hint request requires a hint level');
  }
  if (mode !== 'hint' && !result) {
    throw new TypeError(`${mode} requires a graded result`);
  }
  if ((mode === 'hint' || mode === 'diagnosis') && hasSolutionFigures(part)) {
    throw new TypeError(`${mode} is unavailable when the official solution contains figures`);
  }
  const maxPoints = result?.maxPoints ?? maxPointsForPart(part);
  const context = shared(
    question,
    part,
    submitted,
    maxPoints,
    mode !== 'hint' || input.identity?.attemptPhase === 'correction',
  );
  const options = promptOptions(input.options);
  if (mode === 'hint') {
    const identity = requireLearningIdentity(input.identity, mode);
    return { ...context, ...options, ...identity, mode, hintLevel: input.hintLevel! };
  }
  if (mode === 'diagnosis') {
    const identity = requireLearningIdentity(input.identity, mode);
    return {
      ...context,
      ...options,
      ...identity,
      mode,
      verdict: result!.verdict,
      awardedPoints: result!.awardedPoints,
    };
  }
  return {
    ...context,
    ...options,
    ...(mode === 'walkthrough' ? { mode } : {}),
    verdict: result!.verdict,
    awardedPoints: result!.awardedPoints,
    ...(input.identity ?? {}),
  };
}

function requireLearningIdentity(
  identity: AiRequestContext | undefined,
  mode: 'hint' | 'diagnosis',
): Required<Omit<AiRequestContext, 'clientRequestId'>> & Pick<AiRequestContext, 'clientRequestId'> {
  if (
    !identity?.interactionId
    || !identity.taskVersion
    || !identity.contentSource
    || !identity.contentId
    || !identity.attemptPhase
  ) throw new TypeError(`${mode} requires immutable request provenance`);
  return identity as Required<Omit<AiRequestContext, 'clientRequestId'>> & Pick<AiRequestContext, 'clientRequestId'>;
}

function maxPointsForPart(part: QuestionPart): number {
  if (typeof part.points === 'number' && Number.isFinite(part.points)) return part.points;
  const scoring = part.scoring;
  if (!scoring) return 0;
  if (scoring.mode === 'allOrNothing') return scoring.points;
  if (scoring.mode === 'perBlank') return scoring.max;
  if (scoring.mode === 'tiered') return Math.max(0, ...scoring.tiers.map((tier) => tier.points));
  return scoring.criteria.reduce((sum, criterion) => sum + criterion.points, 0);
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
  identity?: AiRequestContext;
}): AiAssessRequest | null {
  const { question, part, submitted, maxPoints } = input;
  if (!isAiGradable(part)) return null;
  if (!submitted.trim()) return null;
  // A text-only provider cannot safely judge a figure-dependent answer. This
  // is fail-closed even when old Bank metadata accidentally says grader: ai.
  if (hasFigures(question, part)) return null;

  const base = {
    ...shared(question, part, submitted, maxPoints),
    ...promptOptions(input.options),
    ...(input.identity ?? {}),
  };
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
