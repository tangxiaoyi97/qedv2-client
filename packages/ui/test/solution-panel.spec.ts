import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import type { SolutionEntry } from '@qed2/core-logic';
import SolutionPanel from '../src/practice/SolutionPanel.vue';
import { provideAssetResolver } from '../src/shared/assets.js';

const solution: SolutionEntry[] = [
  {
    steps: [{ t: 'text', v: 'Zuerst die beiden Ausdrücke vergleichen.' }],
    result: [
      { t: 'text', v: 'Zutreffend: ' },
      { t: 'math', v: 'b:a' },
      { t: 'text', v: ' und ' },
      { t: 'math', v: 'a\\cdot b' },
    ],
    note: '[0 / 1 Punkt] Ein Punkt ist genau dann zu geben, wenn …',
    alternatives: [[{ t: 'text', v: 'Äquivalent als Produkt schreiben.' }]],
    figures: [{ kind: 'image', src: 'assets/fig/loesung.png', alt: 'Lösungsabbildung' }],
  },
  {
    result: [{ t: 'text', v: 'Alternativer Weg über die Umkehrfunktion.' }],
    note: 'Auch dieser Lösungsweg erhält einen Punkt.',
  },
];

describe('SolutionPanel', () => {
  it('renders the Lösung accordion open by default with all entry content', () => {
    const w = mount(SolutionPanel, { props: { solution } });
    expect(w.text()).toContain('Lösung');
    expect(w.text()).not.toContain('Offizieller Lösungsweg');
    // body open by default
    expect(w.text()).toContain('Zutreffend:');
    // KaTeX math rendered (jsdom-safe)
    expect(w.find('.katex').exists()).toBe(true);
    // grader note as annotation box
    expect(w.text()).toContain('Beurteilungshinweis');
    expect(w.text()).toContain('[0 / 1 Punkt]');
    expect(w.findAll('.q-solution__note')).toHaveLength(2);
    expect(w.text()).toContain('Auch dieser Lösungsweg erhält einen Punkt.');
    // image figure via asset resolver (identity fallback)
    const img = w.find('.q-zfig__img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('assets/fig/loesung.png');
    expect(img.attributes('alt')).toBe('Lösungsabbildung');
  });

  it.each([false, true])('marks the complete first answer for measurement and keeps all notes below it (plain=%s)', (plain) => {
    const w = mount(SolutionPanel, { props: { solution, plain } });
    const previews = w.findAll('[data-solution-preview]');
    expect(previews).toHaveLength(1);
    const preview = previews[0]!;
    expect(preview.text()).toContain('Zuerst die beiden Ausdrücke vergleichen.');
    expect(preview.text()).toContain('Zutreffend:');
    expect(preview.find('.katex').exists()).toBe(true);
    expect(preview.text()).toContain('Äquivalent als Produkt schreiben.');
    expect(preview.get('.q-zfig__img').attributes('alt')).toBe('Lösungsabbildung');
    expect(preview.text()).not.toContain('Beurteilungshinweis');
    expect(preview.text()).not.toContain('Alternativer Weg über die Umkehrfunktion.');
    expect(preview.find('[data-solution-detail]').exists()).toBe(false);

    const entries = w.findAll('.q-solution__entry');
    expect(entries).toHaveLength(2);
    expect(entries[1]!.find('[data-solution-preview]').exists()).toBe(false);
    expect(entries[1]!.get('.q-solution__answer').text()).toContain('Alternativer Weg über die Umkehrfunktion.');
    expect(w.findAll('[data-solution-detail]')).toHaveLength(2);
    for (const [index, entry] of entries.entries()) {
      const note = entry.get('[data-solution-detail]');
      expect(note.text()).toContain('Beurteilungshinweis');
      expect(note.text()).toContain(solution[index]!.note!);
      expect(entry.get('.q-solution__answer').element.nextElementSibling).toBe(note.element);
    }
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
    expect(w.find('.q-zfig__img').attributes('src')).toBe(
      'https://core.example/content/assets/assets/fig/loesung.png',
    );
  });
});
