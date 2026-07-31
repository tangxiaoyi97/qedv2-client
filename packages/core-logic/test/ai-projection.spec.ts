import { describe, expect, it } from 'vitest';
import {
  buildAssessRequest,
  buildExplainRequest,
  figureAlts,
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
    expect(req.verdict).toBe('partial');
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

  it('flattens KaTeX into readable text', () => {
    const req = buildExplainRequest({
      question: question({ prompt: [{ t: 'math', v: '\\mathbb{R}' }] }),
      part: part(),
      submitted: 'x',
      result,
    });
    expect(req.questionPrompt).toContain('ℝ');
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
  });

  it('omits the key entirely when there is nothing to warn about', () => {
    expect(
      buildExplainRequest({ question: question(), part: part(), submitted: 'x', result }).figureAlts,
    ).toBeUndefined();
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

  it('still sends the figure warning so the server can refuse to pre-fill', () => {
    const req = buildAssessRequest({
      question: question({ figures: [{ kind: 'image', src: 'a.svg', alt: 'Graph' }] }),
      part: part(),
      submitted: 'x = 4',
      maxPoints: 2,
    });
    expect(req?.figureAlts).toEqual(['Graph']);
  });
});

/**
 * `answerPreview` returns null for every kind except interval, so using it as
 * the answer text sent every open question to the model empty. This is the
 * projection that actually reads what the user wrote.
 */
describe('submittedText', () => {
  it('reads an open answer', () => {
    expect(submittedText({ kind: 'open', text: '  x = 4 ', selfAssessment: {} })).toBe('x = 4');
  });

  it('reads an expression', () => {
    expect(submittedText({ kind: 'expression', expr: ' 2*x ' })).toBe('2*x');
  });

  it('joins numeric blanks in a stable order', () => {
    // Stable, because the text is part of the AI cache key.
    const values = { b: '2', a: '1' };
    expect(submittedText({ kind: 'numeric', values })).toBe('1 · 2');
    expect(submittedText({ kind: 'numeric', values: { a: '1', b: '2' } })).toBe('1 · 2');
  });

  it('is empty for kinds an AI never sees', () => {
    expect(submittedText({ kind: 'choice', selected: [0] })).toBe('');
    expect(submittedText(null)).toBe('');
    expect(submittedText(undefined)).toBe('');
  });
});
