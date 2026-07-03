import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { SolutionEntry } from '@qed2/core-logic';
import SolutionPanel from '../src/practice/SolutionPanel.vue';
import { provideAssetResolver } from '../src/shared/assets.js';

const solution: SolutionEntry[] = [
  {
    result: [
      { t: 'text', v: 'Zutreffend: ' },
      { t: 'math', v: 'b:a' },
      { t: 'text', v: ' und ' },
      { t: 'math', v: 'a\\cdot b' },
    ],
    note: '[0 / 1 Punkt] Ein Punkt ist genau dann zu geben, wenn …',
    figures: [{ kind: 'image', src: 'assets/fig/loesung.png', alt: 'Lösungsabbildung' }],
  },
  {
    result: [{ t: 'text', v: 'Alternativer Weg über die Umkehrfunktion.' }],
  },
];

describe('SolutionPanel', () => {
  it('renders the Lösung accordion open by default with all entry content', () => {
    const w = mount(SolutionPanel, { props: { solution } });
    expect(w.text()).toContain('Lösung');
    expect(w.text()).toContain('Offizieller Lösungsweg');
    // body open by default
    expect(w.text()).toContain('Zutreffend:');
    // KaTeX math rendered (jsdom-safe)
    expect(w.find('.katex').exists()).toBe(true);
    // grader note as annotation box
    expect(w.text()).toContain('Beurteilungshinweis');
    expect(w.text()).toContain('[0 / 1 Punkt]');
    // image figure via asset resolver (identity fallback)
    const img = w.find('.q-solution__img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('assets/fig/loesung.png');
    expect(img.attributes('alt')).toBe('Lösungsabbildung');
  });

  it('separates multiple entries with an Alternative divider from the 2nd on', () => {
    const w = mount(SolutionPanel, { props: { solution } });
    const dividers = w.findAll('.q-solution__divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]!.text()).toContain('Alternative');
    expect(w.text()).toContain('Alternativer Weg über die Umkehrfunktion.');
  });

  it('respects defaultOpen=false (header visible, body collapsed)', async () => {
    const w = mount(SolutionPanel, { props: { solution, defaultOpen: false } });
    expect(w.text()).toContain('Lösung');
    expect(w.text()).not.toContain('Zutreffend:');
    await w.find('button[aria-expanded]').trigger('click');
    expect(w.text()).toContain('Zutreffend:');
  });

  it('renders nothing when there is no solution', () => {
    const w = mount(SolutionPanel, { props: { solution: undefined } });
    expect(w.find('.q-solution').exists()).toBe(false);
    expect(w.text()).toBe('');
  });

  it('resolves figure paths through a provided asset resolver', () => {
    const Host = defineComponent({
      components: { SolutionPanel },
      setup() {
        provideAssetResolver((src) => `https://core.example/content/assets/${src}`);
        return { solution };
      },
      template: '<SolutionPanel :solution="solution" />',
    });
    const w = mount(Host);
    expect(w.find('.q-solution__img').attributes('src')).toBe(
      'https://core.example/content/assets/assets/fig/loesung.png',
    );
  });
});
