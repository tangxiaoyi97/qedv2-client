import { describe, expect, it } from 'vitest';
import { buildAssessRequest, buildExplainRequest, submittedText } from '../src/ai/projection.js';
import type { Answer, Question, QuestionPart } from '../src/model/question.js';

const text = (v: string) => [{ t: 'text' as const, v }];
const question: Question = {
  id: 'number-sets', schemaVersion: 3, status: 'reviewed', lang: 'de',
  title: 'Zahlenmengen', source: {} as Question['source'], parts: [],
  prompt: text('Gegeben sind fünf Aussagen.'),
};
const identity = {
  interactionId: '4c352212-f3cc-4366-9db0-5247d677b073', taskVersion: 'hint.v1',
  contentSource: 'remote' as const, contentId: 'a'.repeat(40), attemptPhase: 'first' as const,
};
const choice: Answer = {
  kind: 'choice', selectCount: 2, correct: [0, 3],
  options: ['Jede natürliche Zahl ist rational.', 'Jede reelle Zahl ist rational.',
    'Jede ganze Zahl ist positiv.', 'Jede rationale Zahl ist reell.',
    'Jede irrationale Zahl ist ganz.'].map(text),
};
function part(answer: Answer): QuestionPart {
  return {
    id: 'number-sets-a', label: 'a', competencies: [], points: 1, answer,
    prompt: text('Kreuzen Sie die beiden immer zutreffenden Aussagen an.'),
    scoring: { mode: 'allOrNothing', points: 1 },
    solution: [{ result: text('PROTECTED_SOLUTION'), note: 'PROTECTED_GRADING_NOTE' }],
  };
}
function hint(answer: Answer) {
  return buildExplainRequest({ question, part: part(answer), submitted: '',
    mode: 'hint', hintLevel: 1, identity });
}

describe('complete learner-facing AI answer context', () => {
  it.each(['hint', 'diagnosis', 'walkthrough', 'answer'] as const)(
    'includes all five options and the selection count in %s, even before an answer exists', (mode) => {
      const request = buildExplainRequest({
        question, part: part(choice), submitted: '', mode, hintLevel: 1, identity,
        result: { verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 1 },
      });
      expect(request.answerContext).toContain('2 von 5');
      choice.options.forEach((option, index) => {
        const node = option[0]!;
        expect(request.answerContext).toContain(`${String.fromCharCode(65 + index)}) ${'v' in node ? node.v : ''}`);
      });
      expect(request.submitted).toBe('');
      if (mode === 'hint') {
        expect(request).not.toHaveProperty('officialSolution');
        expect(request).not.toHaveProperty('gradingNote');
        expect(request.answerContext).not.toMatch(/correct|PROTECTED|richtig/i);
      }
    },
  );

  it('does not encode the correct indices or matching pairs into public context', () => {
    expect(hint(choice).answerContext).toBe(hint({ ...choice, correct: [1, 2] }).answerContext);
    const answer: Answer = {
      kind: 'matching', left: [text('Erster Satz'), text('Zweiter Satz')],
      right: [text('kleiner'), text('größer'), text('gleich'), text('unabhängig')],
      pairs: [[0, 0], [1, 3]],
      candidateGroups: [
        { label: text('Lücke eins'), leftIndices: [0], rightIndices: [0, 1] },
        { label: text('Lücke zwei'), leftIndices: [1], rightIndices: [2, 3] },
      ],
    };
    const context = hint(answer).answerContext;
    expect(context).toContain('1) Erster Satz');
    expect(context).toContain('2) Zweiter Satz');
    expect(context).toContain('A) kleiner');
    expect(context).toContain('D) unabhängig');
    expect(context).toContain('Lücke eins: 1 → A, B');
    expect(context).toContain('Lücke zwei: 2 → C, D');
    expect(context).toBe(hint({ ...answer, pairs: [[0, 1], [1, 2]] }).answerContext);
  });

  it('keeps mathematical grouping and the position of an unseen option image', () => {
    const request = hint({
      kind: 'choice', selectCount: 1, correct: [1], options: [
        [{ t: 'math', v: '\\frac{x+1}{y+2}' }],
        [{ t: 'fig', src: 'graph-a.svg' }],
        [{ t: 'fig', src: 'graph-b.svg', alt: 'Fallender Graph' }],
      ],
    });
    expect(request.answerContext).toContain('A) \\(\\frac{x+1}{y+2}\\)');
    expect(request.answerContext).toContain('B) [Abbildung nicht übermittelt; keine Beschreibung vorhanden]');
    expect(request.answerContext).toContain('C) [Abbildung nicht übermittelt; Beschreibung: Fallender Graph]');
    expect(request.hasFigures).toBe(true);
    expect(request.figureAlts).toEqual(['Fallender Graph']);
    expect(request.answerContext).not.toContain('graph-a.svg');
  });

  it('preserves the five derivative-rule options from the reported kind of question', () => {
    const formulas = [
      "f(x)=g(x)+h(x) \\Rightarrow f'(x)=g'(x)+h'(x)",
      "f(x)=g(x)\\cdot h(x) \\Rightarrow f'(x)=g'(x)\\cdot h'(x)",
      "f(x)=\\frac{g(x)}{h(x)} \\Rightarrow f'(x)=\\frac{g'(x)}{h'(x)}",
      "f(x)=k\\cdot g(x) \\Rightarrow f'(x)=k\\cdot g'(x)",
      "f(x)=g(h(x)) \\Rightarrow f'(x)=g'(h(x))",
    ];
    const context = hint({ kind: 'choice', correct: [0, 3], selectCount: 2,
      options: formulas.map((v) => [{ t: 'math', v }]) }).answerContext;
    formulas.forEach((formula, index) => expect(context)
      .toContain(`${String.fromCharCode(65 + index)}) \\(${formula}\\)`));
    expect(context).toContain('2 von 5');
  });

  it('includes numeric blank identities and units without values or tolerances', () => {
    const answer: Answer = { kind: 'numeric', blanks: [
      { id: 's', unit: 'km', value: 713, tol: 0.041 },
      { id: 't', unit: 'h', value: 419, tol: 0.092 },
    ] };
    const context = hint(answer).answerContext;
    expect(context).toContain('s (Einheit: km)');
    expect(context).toContain('t (Einheit: h)');
    expect(context).not.toMatch(/713|419|0\.041|0\.092/);
  });

  it('includes expression variables without the canonical solution', () => {
    const context = hint({ kind: 'expression', canonical: '2*x_n+731', vars: ['x_n'], checker: 'cas' }).answerContext;
    expect(context).toContain('Mathematischer Ausdruck');
    expect(context).toContain('x_n');
    expect(context).not.toContain('731');
  });

  it('preserves fraction and root grouping in the question, solution and submitted selections', () => {
    const fraction = [{ t: 'math' as const, v: '\\frac{a+b}{c+d}' }];
    const root = [{ t: 'math' as const, v: '\\sqrt{x+1}' }];
    const q = { ...question, prompt: fraction };
    const p = { ...part(choice), prompt: root,
      solution: [{ steps: fraction, result: root, alternatives: [fraction] }] };
    const request = buildExplainRequest({ question: q, part: p, submitted: '', mode: 'walkthrough' });
    expect(request.questionPrompt).toBe('\\(\\frac{a+b}{c+d}\\)');
    expect(request.partPrompt).toBe('\\(\\sqrt{x+1}\\)');
    expect(request.solution?.steps?.[0]?.text).toBe(request.questionPrompt);
    expect(request.solution?.result).toBe(request.partPrompt);
    expect(request.solution?.alternatives).toEqual([request.questionPrompt]);
    expect(submittedText({ kind: 'choice', selected: [0] }, { ...choice, options: [fraction] }))
      .toBe('A) \\(\\frac{a+b}{c+d}\\)');
    expect(submittedText({ kind: 'matching', matches: [0] }, {
      kind: 'matching', left: [fraction], right: [root], pairs: [[0, 0]],
    })).toBe('\\(\\frac{a+b}{c+d}\\) → \\(\\sqrt{x+1}\\)');
    const assess = buildAssessRequest({ question: q, part: { ...p,
      answer: { kind: 'open', grader: 'ai', rubric: fraction } },
      submitted: 'Mein Ansatz', maxPoints: 1, scoreOptions: [0, 1] });
    expect(assess?.questionPrompt).toBe(request.questionPrompt);
    expect(assess?.rubricText).toBe(request.questionPrompt);
  });

  it('describes interval input without revealing endpoints or their inclusion', () => {
    const context = hint({ kind: 'interval', lower: -317, upper: 731, lowerClosed: true, upperClosed: false }).answerContext;
    expect(context).toContain('Intervall');
    expect(context).toContain('offen oder geschlossen');
    expect(context).not.toMatch(/317|731/);
  });

  it('does not move private open-answer rubrics into first-attempt context', () => {
    const open = { kind: 'open' as const, grader: 'ai' as const, rubric: text('PROTECTED_RUBRIC') };
    expect(JSON.stringify(hint(open))).not.toContain('PROTECTED');
    const request = buildAssessRequest({ question, part: part(open), submitted: 'Mein Ansatz',
      maxPoints: 1, scoreOptions: [0, 1] });
    expect(request?.questionPrompt).toBe('Gegeben sind fünf Aussagen.');
    expect(request?.rubricText).toBe('PROTECTED_RUBRIC');
  });

  it('rejects oversized options before a request can buy help for a truncated question', () => {
    expect(() => hint({ ...choice, options: [text('x'.repeat(8100))] })).toThrow('zu umfangreich');
  });
});
