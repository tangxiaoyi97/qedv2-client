import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HighlightSnippet from '../src/shared/HighlightSnippet.vue';
import RadarChart from '../src/review/RadarChart.vue';
import MatchingControl from '../src/question/MatchingControl.vue';
import type { MatchingAnswer } from '@qed2/core-logic';

describe('HighlightSnippet (search upgrade §3 — <em> whitelist)', () => {
  it('renders <em> hits as highlight elements', () => {
    const w = mount(HighlightSnippet, { props: { snippet: 'vor <em>Dreieck</em> nach' } });
    const hit = w.find('em');
    expect(hit.exists()).toBe(true);
    expect(hit.text()).toBe('Dreieck');
    expect(w.text()).toBe('vor Dreieck nach');
  });

  it('never turns other markup into elements (injection defense)', () => {
    const w = mount(HighlightSnippet, {
      props: { snippet: '&lt;script&gt;alert(1)&lt;/script&gt; <em>x</em> <img src=x>' },
    });
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    // escaped entities become visible text, the img "tag" stays literal text
    expect(w.text()).toContain('<script>alert(1)</script>');
    expect(w.text()).toContain('<img src=x>');
    expect(w.findAll('em')).toHaveLength(1);
  });
});

describe('RadarChart', () => {
  it('renders one polygon, a point and a label per axis', () => {
    const w = mount(RadarChart, {
      props: {
        axes: [
          { label: 'AG', value: 0.8, hint: '80 %' },
          { label: 'FA', value: 0.4 },
          { label: 'AN', value: 0.2 },
          { label: 'WS', value: 0.6 },
        ],
      },
    });
    expect(w.findAll('.q-radar__area')).toHaveLength(1);
    expect(w.findAll('.q-radar__point')).toHaveLength(4);
    expect(w.text()).toContain('AG');
    expect(w.text()).toContain('80 %');
  });
});

describe('MatchingControl drag & drop', () => {
  const answer: MatchingAnswer = {
    kind: 'matching',
    left: [[{ t: 'text', v: 'L1' }], [{ t: 'text', v: 'L2' }]],
    right: [[{ t: 'text', v: 'R-A' }], [{ t: 'text', v: 'R-B' }], [{ t: 'text', v: 'R-C' }]],
    pairs: [
      [0, 0],
      [1, 1],
    ],
  };

  function dataTransfer(payload?: string): DataTransfer {
    let stored = payload ?? '';
    return {
      setData: (_t: string, v: string) => {
        stored = v;
      },
      getData: () => stored,
      effectAllowed: 'move',
    } as unknown as DataTransfer;
  }

  it('dropping a pool chip assigns it to the row', async () => {
    const w = mount(MatchingControl, {
      props: { answer, modelValue: [null, null] },
    });
    const rows = w.findAll('.q-match__row');
    await rows[0]!.trigger('drop', { dataTransfer: dataTransfer('2') });
    const emitted = w.emitted('update:modelValue');
    expect(emitted?.at(-1)?.[0]).toEqual([2, null]);
  });

  it('dropping an already-used option MOVES it (one-to-one preserved)', async () => {
    const w = mount(MatchingControl, {
      props: { answer, modelValue: [1, null] },
    });
    const rows = w.findAll('.q-match__row');
    await rows[1]!.trigger('drop', { dataTransfer: dataTransfer('1') });
    expect(w.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([null, 1]);
  });

  it('pool chips are draggable while answering; the pool disappears in review', () => {
    const answering = mount(MatchingControl, { props: { answer, modelValue: [null, null] } });
    expect(answering.find('.q-match__pool-item').attributes('draggable')).toBe('true');
    const review = mount(MatchingControl, {
      props: {
        answer,
        modelValue: [0, 1],
        result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1, breakdown: [] },
      },
    });
    expect(review.find('.q-match__pool').exists()).toBe(false);
  });
});
