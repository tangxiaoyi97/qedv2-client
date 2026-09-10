import { describe, expect, it } from 'vitest';
import {
  buildAssessRequest,
  buildExplainRequest,
  figureAlts,
  hasFigures,
  hasSolutionFigures,
  hintRevealsOfficialSolution,
  isAiGradable,
  submittedText,
} from '../src/ai/projection.js';
import type { Question, QuestionPart } from '../src/model/question.js';
import type { GradeResult } from '../src/grading/types.js';

/**
 * The server never calls qed2-core, so everything an AI sees is projected
 * here. These tests pin what may be sent — and, more importantly, when the
 * client must refuse to ask at all.
 */

const text = (v: string) => [{ t: 'text' as const, v }];

function part(overrides: Partial<QuestionPart> = {}): QuestionPart {
  return {
    id: 'q1-a',
    label: 'a',
    competencies: [],
    prompt: text('Berechne x.'),
    points: 2,
    answer: { kind: 'open', rubric: text('raster'), grader: 'ai' },
    scoring: {
      mode: 'rubric',
      criteria: [
        { desc: 'x korrekt berechnet', points: 1 },
        { desc: 'Rechenweg gezeigt', points: 1 },
      ],
    },
    solution: [{ result: text('x = 4'), note: 'Ein Punkt je Teilschritt.' }],
    ...overrides,
  } as QuestionPart;
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q1',
    schemaVersion: 3,
    status: 'published',
    lang: 'de',
    source: {} as Question['source'],
    title: 'Gleichung',
    prompt: text('Gegeben sei 2x = 8.'),
    parts: [],
    ...overrides,
  } as Question;
}

const result: GradeResult = { verdict: 'partial', correct: false, awardedPoints: 1, maxPoints: 2 };
const learningIdentity = {
  interactionId: '4c352212-f3cc-4366-9db0-5247d677b073',
  taskVersion: 'hint.v1',
  contentSource: 'remote' as const,
  contentId: 'a'.repeat(40),
  attemptPhase: 'first' as const,
};

describe('explain request', () => {
  it('carries the question text, not just the answer', () => {
    // The first draft of the protocol forgot this and the model would have had
    // nothing to reason about.
    const req = buildExplainRequest({
      question: question(),
      part: part(),
      submitted: 'x = 5',
      result,
    });
    expect(req.questionPrompt).toContain('2x = 8');
    expect(req.partPrompt).toContain('Berechne x');
    expect(req.submitted).toBe('x = 5');
    expect(req.officialSolution).toBe('x = 4');
    expect(req.gradingNote).toContain('Teilschritt');
    expect(req.maxPoints).toBe(2);
    expect('verdict' in req ? req.verdict : undefined).toBe('partial');
  });

  it('omits an empty official solution rather than sending a blank string', () => {
    const req = buildExplainRequest({
      question: question(),
      part: part({ solution: [{ result: text('  ') }] }),
      submitted: 'x = 5',
      result,
    });
    expect(req.officialSolution).toBeUndefined();
    expect(req.gradingNote).toBeUndefined();
  });

  it('keeps ordered steps-only solutions and short alternatives', () => {
    const req = buildExplainRequest({
      question: question(),
      part: part({
        solution: [{
          id: 'weg-1',
          steps: text('2x = 8, also x = 4'),
          alternatives: [text('Durch 2 teilen')],
        }],
      }),
      submitted: 'x = 5',
      result,
    });
    expect(req.officialSolution).toContain('2x = 8');
    expect(req.solution).toEqual({
      steps: [{ id: 'weg-1', text: '2x = 8, also x = 4' }],
      alternatives: ['Durch 2 teilen'],
    });
  });

  it('flattens KaTeX into readable text', () => {
    const req = buildExplainRequest({
      question: question({ prompt: [{ t: 'math', v: '\\mathbb{R}' }] }),
      part: part(),
      submitted: 'x',
      result,
    });
    expect(req.questionPrompt).toContain('ℝ');
  });

  it('keeps every official answer field out of a first-attempt hint', () => {
    const req = buildExplainRequest({
      question: question(),
      part: part(),
      submitted: '',
      mode: 'hint',
      hintLevel: 1,
      identity: learningIdentity,
    });
    expect(req.solutionHasFigures).toBe(false);
    expect(req.officialSolution).toBeUndefined();
    expect(req.solution).toBeUndefined();
    expect(req.gradingNote).toBeUndefined();
  });

  it('grounds a correction hint in the official solution only after the first attempt', () => {
    const req = buildExplainRequest({
      question: question(),
      part: part(),
      submitted: 'x = 5',
      mode: 'hint',
      hintLevel: 2,
      identity: { ...learningIdentity, attemptPhase: 'correction' },
    });
    expect(req.officialSolution).toBe('x = 4');
    expect(req.solution?.result).toBe('x = 4');
    expect(req.gradingNote).toContain('Teilschritt');
  });

  it('detects a final result, every alternative, and the last steps-only clause', () => {
    const protectedPart = part({
      solution: [{
        steps: text('Zuerst umformen; somit y = 9'),
        result: text('x = 4'),
        alternatives: [text('x = -4'), text('Keine Lösung')],
      }],
    });
    expect(hintRevealsOfficialSolution('Das Ergebnis ist **x = 4**.', protectedPart)).toBe(true);
    expect(hintRevealsOfficialSolution('Schreibe nun x=4 hin.', protectedPart)).toBe(true);
    expect(hintRevealsOfficialSolution('Als Ergebnis erhältst du 4.', protectedPart)).toBe(true);
    expect(hintRevealsOfficialSolution('Eine andere Möglichkeit wäre x = -4.', protectedPart)).toBe(true);
    expect(hintRevealsOfficialSolution('Damit erhältst du y = 9.', protectedPart)).toBe(true);
    expect(hintRevealsOfficialSolution('Prüfe zunächst den Zwischenschritt 17.', protectedPart)).toBe(false);
  });

  it('protects authoritative answers even when the prose solution rounds differently', () => {
    const numeric = part({
      answer: {
        kind: 'numeric',
        blanks: [{ id: 'v', value: 37.5, tol: 0.5, unit: 'km/h' }],
      },
      solution: [{ result: text('v ≈ 37,2 km/h') }],
    });
    expect(hintRevealsOfficialSolution('Trage 37,5 km/h ein.', numeric)).toBe(true);
    expect(hintRevealsOfficialSolution('Trage 37.5 ein.', numeric)).toBe(true);

    const expression = part({
      answer: { kind: 'expression', canonical: 'x_n\\cdot 1{,}03', vars: ['x_n'], checker: 'cas' },
      solution: [],
    });
    expect(hintRevealsOfficialSolution('x_n · 1,03', expression)).toBe(true);

    const interval = part({
      answer: { kind: 'interval', lower: -2, upper: 5, lowerClosed: true, upperClosed: false },
      solution: [],
    });
    expect(hintRevealsOfficialSolution('Die Menge ist [-2; 5[.', interval)).toBe(true);
    expect(hintRevealsOfficialSolution('Prüfe zunächst den Zwischenschritt 17.', interval)).toBe(false);
  });
});

describe('figures', () => {
  it('reports alt text from both the question and the part', () => {
    const q = question({ figures: [{ kind: 'image', src: 'a.svg', alt: 'Graph von f' }] });
    const p = part({ figures: [{ kind: 'image', src: 'b.svg', alt: 'Skizze' }] });
    expect(figureAlts(q, p)).toEqual(['Graph von f', 'Skizze']);
    expect(buildExplainRequest({ question: q, part: p, submitted: 'x', result }).figureAlts).toEqual([
      'Graph von f',
      'Skizze',
    ]);
    expect(buildExplainRequest({ question: q, part: p, submitted: 'x', result }).hasFigures).toBe(true);
  });

  it('detects inline and solution figures, including figures without alt text', () => {
    const q = question({
      prompt: [...text('Lies ab:'), { t: 'fig', src: 'inline.svg' }],
    });
    const p = part({
      solution: [
        {
          result: [{ t: 'fig', src: 'solution.svg', alt: 'Lösungsskizze' }],
          figures: [{ kind: 'image', src: 'extra.svg' }],
        },
      ],
    });
    const req = buildExplainRequest({ question: q, part: p, submitted: 'x', result });
    expect(hasFigures(q, p)).toBe(true);
    expect(req.hasFigures).toBe(true);
    expect(req.figureAlts).toBeUndefined();
    expect(req.solutionHasFigures).toBe(true);
    expect(hasSolutionFigures(p)).toBe(true);
    expect(() => buildExplainRequest({
      question: q,
      part: p,
      submitted: '',
      mode: 'hint',
      hintLevel: 1,
      identity: learningIdentity,
    })).toThrow('official solution contains figures');
  });

  it('treats an open rubric figure as protected answer material', () => {
    const p = part({
      answer: {
        kind: 'open',
        grader: 'ai',
        rubric: [{ t: 'fig', src: 'rubric.svg', alt: 'Antwort: 17' }],
      },
    });
    expect(figureAlts(question(), p)).toEqual([]);
    expect(hasSolutionFigures(p)).toBe(true);
    expect(() => buildExplainRequest({
      question: question(),
      part: p,
      submitted: '17',
      result,
      mode: 'diagnosis',
      identity: { ...learningIdentity, taskVersion: 'diagnosis.v1' },
    })).toThrow('official solution contains figures');
  });

  it('omits the key entirely when there is nothing to warn about', () => {
    const req = buildExplainRequest({ question: question(), part: part(), submitted: 'x', result });
    expect(req.figureAlts).toBeUndefined();
    expect(req.hasFigures).toBeUndefined();
    expect(req.solutionHasFigures).toBe(false);
  });
});

describe('assess gating', () => {
  it('accepts any open part the bank marked grader:"ai", whatever the scoring', () => {
    // The bank decides. Roughly a third of AI-marked open parts in the real
    // question bank are allOrNothing or tiered rather than rubric; gating on
    // rubric alone silently excluded all of them.
    expect(isAiGradable(part())).toBe(true);
    expect(isAiGradable(part({ scoring: { mode: 'allOrNothing', points: 2 } }))).toBe(true);
    expect(isAiGradable(part({ answer: { kind: 'open', rubric: text('r'), grader: 'self' } }))).toBe(
      false,
    );
    const numeric = { ...part(), answer: { kind: 'numeric', value: 4, tolerance: 0 } } as unknown as QuestionPart;
    expect(isAiGradable(numeric)).toBe(false);
  });

  it('sends scoreOptions and the rubric prose for a non-rubric part', () => {
    const req = buildAssessRequest({
      question: question(),
      part: part({ scoring: { mode: 'allOrNothing', points: 1 } }),
      submitted: 'x = 4',
      maxPoints: 1,
      scoreOptions: [1, 0, 1],
    });
    expect(req?.criteria).toBeUndefined();
    expect(req?.scoreOptions).toEqual([0, 1]); // deduped and sorted
    expect(req?.rubricText).toBe('raster');
  });

  it('refuses a non-rubric part with nothing to choose between', () => {
    for (const scoreOptions of [undefined, [], [1]]) {
      expect(
        buildAssessRequest({
          question: question(),
          part: part({ scoring: { mode: 'allOrNothing', points: 1 } }),
          submitted: 'x = 4',
          maxPoints: 1,
          ...(scoreOptions ? { scoreOptions } : {}),
        }),
      ).toBeNull();
    }
  });

  it('numbers the criteria so the model can only answer about real ones', () => {
    const req = buildAssessRequest({
      question: question(),
      part: part(),
      submitted: 'x = 4, weil 8/2 = 4',
      maxPoints: 2,
    });
    expect(req?.criteria).toEqual([
      { index: 0, desc: 'x korrekt berechnet', points: 1 },
      { index: 1, desc: 'Rechenweg gezeigt', points: 1 },
    ]);
  });

  it('refuses an empty answer — there is nothing to evidence a criterion with', () => {
    for (const submitted of ['', '   ']) {
      expect(
        buildAssessRequest({ question: question(), part: part(), submitted, maxPoints: 2 }),
      ).toBeNull();
    }
  });

  it('prefers criteria when the part has them', () => {
    const req = buildAssessRequest({
      question: question(),
      part: part(),
      submitted: 'x = 4',
      maxPoints: 2,
      scoreOptions: [0, 1, 2],
    });
    expect(req?.criteria).toHaveLength(2);
    expect(req?.scoreOptions).toBeUndefined();
  });

  it('refuses a part the bank did not open to AI', () => {
    expect(
      buildAssessRequest({
        question: question(),
        part: part({ answer: { kind: 'open', rubric: text('r'), grader: 'self' } }),
        submitted: 'x = 4',
        maxPoints: 2,
      }),
    ).toBeNull();
  });

  it('fails closed for any figure-dependent assessment', () => {
    const req = buildAssessRequest({
      question: question({ figures: [{ kind: 'image', src: 'a.svg', alt: 'Graph' }] }),
      part: part(),
      submitted: 'x = 4',
      maxPoints: 2,
    });
    expect(req).toBeNull();
  });

  it('fails closed when a figure is hidden inside steps or an alternative', () => {
    const req = buildAssessRequest({
      question: question(),
      part: part({
        solution: [{
          steps: [{ t: 'fig', src: 'step.svg' }],
          alternatives: [[{ t: 'fig', src: 'alternative.svg' }]],
        }],
      }),
      submitted: 'x = 4',
      maxPoints: 2,
    });
    expect(req).toBeNull();
  });
});

/**
 * `answerPreview` returns null for every kind except interval, so using it as
 * the answer text sent every open question to the model empty. This is the
 * projection that actually reads what the user wrote.
 */
describe('submittedText', () => {
  it('keeps interval endpoint choices distinct in AI request identity', () => {
    const bounds = { kind: 'interval' as const, lower: '2', upper: '5' };
    const projections = [false, true].flatMap((lowerClosed) => [false, true].map((upperClosed) =>
      submittedText({ ...bounds, lowerClosed, upperClosed })));
    expect(new Set(projections).size).toBe(4);
  });

  it('keeps numeric blank identities and empty positions distinct', () => {
    const first = submittedText({ kind: 'numeric', values: { a: '1', b: '' } });
    const second = submittedText({ kind: 'numeric', values: { a: '', b: '1' } });
    expect(first).not.toBe(second);
    expect(first).toContain('a');
    expect(second).toContain('b');
  });

  it('represents unbounded interval endpoints using the same meaning as the grader', () => {
    expect(submittedText({ kind: 'interval', lower: '', upper: 'inf', lowerClosed: true, upperClosed: true }))
      .toBe(']−∞; +∞[');
    expect(submittedText({ kind: 'interval', lower: '-inf', upper: '5', lowerClosed: true, upperClosed: true }))
      .toBe(']−∞; 5]');
  });

  it('includes missing authored numeric blanks without treating an empty answer as filled', () => {
    const answer = { kind: 'numeric' as const, blanks: [{ id: 'x', value: 1, tol: 0 }, { id: 'y', value: 2, tol: 0 }] };
    expect(submittedText({ kind: 'numeric', values: { y: '2' } }, answer)).toBe('x: (leer)\ny: 2');
    expect(submittedText({ kind: 'numeric', values: {} }, answer)).toBe('');
  });

  it('reads an open answer', () => {
    expect(submittedText({ kind: 'open', text: '  x = 4 ', selfAssessment: {} })).toBe('x = 4');
  });

  it('reads an expression', () => {
    expect(submittedText({ kind: 'expression', expr: ' 2*x ' })).toBe('2*x');
  });

  it('joins numeric blanks in a stable order', () => {
    // Stable, because the text is part of the AI cache key.
    const values = { b: '2', a: '1' };
    expect(submittedText({ kind: 'numeric', values })).toBe('a: 1\nb: 2');
    expect(submittedText({ kind: 'numeric', values: { a: '1', b: '2' } })).toBe('a: 1\nb: 2');
  });

  it('is empty when there is no submission at all', () => {
    expect(submittedText(null)).toBe('');
    expect(submittedText(undefined)).toBe('');
    // Matching has no readable projection yet, so it stays empty rather than
    // sending pair indices a model cannot interpret.
    expect(submittedText({ kind: 'matching', matches: [] })).toBe('');
  });
});

/**
 * Language and custom instructions are preferences the client owns and sends
 * per request — no server table, no migration for two strings.
 */
describe('prompt options', () => {
  const base = { question: question(), part: part(), submitted: 'x = 5', result };

  it('rides the explain request', () => {
    const req = buildExplainRequest({
      ...base,
      options: { language: 'English', customInstructions: '  Use simple words.  ' },
    });
    expect(req.language).toBe('English');
    expect(req.customInstructions).toBe('Use simple words.');
  });

  it('rides the assess request too', () => {
    const req = buildAssessRequest({
      question: question(),
      part: part(),
      submitted: 'x = 4',
      maxPoints: 2,
      options: { language: '中文' },
    });
    expect(req?.language).toBe('中文');
  });

  it('preserves both billing choices instead of treating BYO as automatic routing', () => {
    expect(buildExplainRequest({ ...base, options: { preferPool: true } }).preferPool).toBe(true);
    expect(buildExplainRequest({ ...base, options: { preferPool: false } }).preferPool).toBe(false);
    expect(buildExplainRequest(base).preferPool).toBeUndefined();
  });

  it('sends nothing rather than blanks the server has to ignore', () => {
    const req = buildExplainRequest({ ...base, options: { language: '  ', customInstructions: '' } });
    expect(req.language).toBeUndefined();
    expect(req.customInstructions).toBeUndefined();
    expect(buildExplainRequest(base).language).toBeUndefined();
  });

  it('marks a walkthrough, and leaves the default unmarked', () => {
    // `answer` is the default, so it costs nothing on the wire.
    expect(buildExplainRequest({ ...base, mode: 'walkthrough' }).mode).toBe('walkthrough');
    expect(buildExplainRequest({ ...base, mode: 'answer' }).mode).toBeUndefined();
    expect(buildExplainRequest(base).mode).toBeUndefined();
  });

  it('explains the solution before self-assessment without inventing a grade', () => {
    const request = buildExplainRequest({
      question: question(), part: part(), submitted: 'Mein Ansatz', mode: 'walkthrough',
    });
    expect(request).toMatchObject({ mode: 'walkthrough', submitted: 'Mein Ansatz', maxPoints: 2 });
    expect(request).not.toHaveProperty('verdict');
    expect(request).not.toHaveProperty('awardedPoints');
    expect(() => buildExplainRequest({
      question: question(), part: part(), submitted: 'Mein Ansatz', mode: 'answer',
    })).toThrow('requires a graded result');
  });
});

/**
 * Choice is the most common question type. Sending bare indices produced a
 * real Gemini reply of "no answer was given" — the model had nothing to work
 * with, so the whole explanation feature was useless on those questions.
 */
describe('submittedText for pickable answers', () => {
  const choiceAnswer = {
    kind: 'choice' as const,
    selectCount: 2,
    correct: [1, 3],
    options: [text('a + b'), text('b : a'), text('a : b'), text('a · b'), text('b − a')],
  };

  it('resolves selected indices against the option texts', () => {
    const out = submittedText({ kind: 'choice', selected: [0, 3] }, choiceAnswer);
    expect(out).toContain('A) a + b');
    expect(out).toContain('D) a · b');
  });

  it('falls back to letters when the options are not to hand', () => {
    expect(submittedText({ kind: 'choice', selected: [0, 3] })).toBe('A, D');
  });

  it('reads an interval', () => {
    expect(submittedText({ kind: 'interval', lower: '2', upper: '5', lowerClosed: true, upperClosed: false })).toBe(
      '[2; 5[',
    );
  });
});

describe('submittedText for matching', () => {
  const matchingAnswer = {
    kind: 'matching' as const,
    left: [text('Median'), text('Modus')],
    right: [text('mittlerer Wert'), text('häufigster Wert'), text('Mittelwert')],
    pairs: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
  };

  it('names both sides of each pair', () => {
    const out = submittedText({ kind: 'matching', matches: [0, 1] }, matchingAnswer);
    expect(out).toContain('Median → mittlerer Wert');
    expect(out).toContain('Modus → häufigster Wert');
  });

  it('skips what the user left unassigned', () => {
    const out = submittedText({ kind: 'matching', matches: [2, null] }, matchingAnswer);
    expect(out).toBe('Median → Mittelwert');
  });

  it('stays empty without the answer to resolve against', () => {
    expect(submittedText({ kind: 'matching', matches: [0, 1] })).toBe('');
  });
});
