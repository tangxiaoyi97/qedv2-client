import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SessionProgressBar from '../src/practice/SessionProgressBar.vue';

type Verdict = 'correct' | 'partial' | 'incorrect';

const items = (n: number): { partId: string }[] =>
  Array.from({ length: n }, (_, i) => ({ partId: `p${i + 1}` }));

function states(wrapper: { findAll: (s: string) => { classes: () => string[] }[] }): string[] {
  return wrapper.findAll('.q-sprogress__seg').map((el) => {
    const cls = el.classes().find((c: string) => c.startsWith('q-sprogress__seg--'));
    return cls?.replace('q-sprogress__seg--', '') ?? '';
  });
}

function mountBar(props: {
  count: number;
  graded?: { partId: string; verdict: Verdict }[];
  currentIndex?: number;
  active?: boolean;
}) {
  return mount(SessionProgressBar, {
    props: {
      items: items(props.count),
      graded: props.graded ?? [],
      currentIndex: props.currentIndex ?? 0,
      active: props.active ?? true,
    },
  });
}

describe('SessionProgressBar', () => {
  it('renders one segment per session item', () => {
    expect(states(mountBar({ count: 5 }))).toHaveLength(5);
  });

  it('colours each segment by its verdict and leaves skipped parts open', () => {
    // The user answered 1 and 4 and jumped to 3 — 2 and 5 were never touched.
    const wrapper = mountBar({
      count: 5,
      graded: [
        { partId: 'p1', verdict: 'correct' },
        { partId: 'p4', verdict: 'incorrect' },
      ],
      currentIndex: 2,
    });
    // A percentage bar would claim 40 % here and say nothing about the gap.
    expect(states(wrapper)).toEqual(['correct', 'open', 'current', 'incorrect', 'open']);
  });

  it('marks partial credit distinctly from right and wrong', () => {
    const wrapper = mountBar({
      count: 2,
      graded: [
        { partId: 'p1', verdict: 'partial' },
        { partId: 'p2', verdict: 'correct' },
      ],
    });
    expect(states(wrapper)).toEqual(['partial', 'correct']);
  });

  it('drops the "you are here" marker once the session is not running', () => {
    const wrapper = mountBar({ count: 3, currentIndex: 1, active: false });
    expect(states(wrapper)).toEqual(['open', 'open', 'open']);
  });

  it('describes the whole bar for screen readers', () => {
    const wrapper = mountBar({
      count: 3,
      graded: [
        { partId: 'p1', verdict: 'correct' },
        { partId: 'p2', verdict: 'incorrect' },
      ],
      currentIndex: 2,
    });
    expect(wrapper.get('.q-sprogress').attributes('aria-label')).toBe(
      'Fortschritt: 1 richtig, 0 teilweise, 1 falsch, 1 offen',
    );
  });

  it('tightens the separators once segments get thin', () => {
    expect(mountBar({ count: 24 }).classes()).not.toContain('q-sprogress--dense');
    expect(mountBar({ count: 25 }).classes()).toContain('q-sprogress--dense');
  });
});
