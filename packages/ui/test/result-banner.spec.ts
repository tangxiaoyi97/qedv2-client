import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { GradeResult } from '@qed2/core-logic';
import ResultBanner from '../src/practice/ResultBanner.vue';
import StateIcon from '../src/shared/StateIcon.vue';

function result(partial: Partial<GradeResult>): GradeResult {
  return {
    verdict: 'correct',
    correct: true,
    awardedPoints: 1,
    maxPoints: 1,
    ...partial,
  };
}

describe('ResultBanner', () => {
  it('renders the correct variant with label, icon and points', () => {
    const w = mount(ResultBanner, { props: { result: result({}) } });
    expect(w.classes()).toContain('q-result-banner--correct');
    expect(w.text()).toContain('Richtig');
    expect(w.text()).toContain('1 / 1');
    expect(w.text()).toContain('Punkte');
    expect(w.findComponent(StateIcon).props('state')).toBe('correct');
  });

  it('renders the partial variant with a German decimal comma', () => {
    const w = mount(ResultBanner, {
      props: {
        result: result({ verdict: 'partial', correct: false, awardedPoints: 0.5, maxPoints: 1 }),
      },
    });
    expect(w.classes()).toContain('q-result-banner--partial');
    expect(w.text()).toContain('Teilweise richtig');
    expect(w.text()).toContain('0,5 / 1');
    expect(w.findComponent(StateIcon).props('state')).toBe('partial');
  });

  it('renders the incorrect variant', () => {
    const w = mount(ResultBanner, {
      props: {
        result: result({ verdict: 'incorrect', correct: false, awardedPoints: 0, maxPoints: 2 }),
      },
    });
    expect(w.classes()).toContain('q-result-banner--incorrect');
    expect(w.text()).toContain('Falsch');
    expect(w.text()).toContain('0 / 2');
    expect(w.findComponent(StateIcon).props('state')).toBe('incorrect');
  });

  it('renders an optional secondary line through the slot', () => {
    const w = mount(ResultBanner, {
      props: { result: result({}) },
      slots: { default: 'Eine von zwei Aussagen war korrekt.' },
    });
    expect(w.text()).toContain('Eine von zwei Aussagen war korrekt.');
  });
});
