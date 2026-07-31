import { describe, expect, it } from 'vitest';
import {
  buildAssessRequest,
  buildExplainRequest,
  figureAlts,
  isAiGradable,
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
  it('only accepts open parts the bank marked grader:"ai" with rubric scoring', () => {
    expect(isAiGradable(part())).toBe(true);
    // The bank decides; a rubric alone is not consent.
    expect(isAiGradable(part({ answer: { kind: 'open', rubric: text('r'), grader: 'self' } }))).toBe(
      false,
    );
    const numeric = { ...part(), answer: { kind: 'numeric', value: 4, tolerance: 0 } } as unknown as QuestionPart;
    expect(isAiGradable(numeric)).toBe(false);
    expect(isAiGradable(part({ scoring: { mode: 'allOrNothing', points: 2 } }))).toBe(false);
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
