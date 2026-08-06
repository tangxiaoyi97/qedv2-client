import { describe, expect, it } from 'vitest';
import { suggestedSelfAssessment, type AiAssessResponse } from '../src/index.js';

const base = {
  model: 'test',
  promptVersion: '1',
  source: 'byo' as const,
};

describe('suggestedSelfAssessment', () => {
  it('maps a verified overall score onto an allowed self-assessment', () => {
    const answer: AiAssessResponse = {
      ...base,
      advisoryOnly: false,
      overall: { points: 1, confidence: 0.9, quote: 'x = 4', reason: '', quoteVerified: true },
    };
    expect(
      suggestedSelfAssessment({
        answer,
        current: {},
        maxPoints: 2,
        criterionCount: 0,
        allowedPoints: [0, 1, 2],
      }),
    ).toEqual({ awardedPoints: 1, overall: 'partial' });
  });

  it('refuses advisory, low-confidence, unevidenced or impossible scores', () => {
    const overall = { points: 2, confidence: 0.9, quote: '', reason: '', quoteVerified: false };
    for (const answer of [
      { ...base, advisoryOnly: true, overall: { ...overall, quoteVerified: true } },
      { ...base, advisoryOnly: false, overall: { ...overall, confidence: 0.5, quoteVerified: true } },
      { ...base, advisoryOnly: false, overall },
      { ...base, advisoryOnly: false, overall: { ...overall, points: 1.5, quoteVerified: true } },
    ] satisfies AiAssessResponse[]) {
      expect(
        suggestedSelfAssessment({
          answer,
          current: {},
          maxPoints: 2,
          criterionCount: 0,
          allowedPoints: [0, 1, 2],
        }),
      ).toBeNull();
    }
  });

  it('only selects criteria backed by confidence and a verified quote', () => {
    const answer: AiAssessResponse = {
      ...base,
      advisoryOnly: false,
      criteria: [
        { index: 0, met: true, confidence: 0.9, quote: 'a', reason: '', quoteVerified: true },
        { index: 1, met: true, confidence: 0.7, quote: 'b', reason: '', quoteVerified: true },
        { index: 2, met: false, confidence: 1, quote: '', reason: '', quoteVerified: false },
      ],
    };
    expect(
      suggestedSelfAssessment({ answer, current: {}, maxPoints: 3, criterionCount: 3 }),
    ).toEqual({ criteriaMet: [true, false, false] });
  });
});
