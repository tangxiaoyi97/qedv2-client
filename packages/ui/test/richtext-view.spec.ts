import { afterEach, describe, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { RichText } from '@qed2/core-logic';
import RichTextView from '../src/shared/RichTextView.vue';
import FigureViewer from '../src/shared/FigureViewer.vue';
import { provideAssetResolver } from '../src/shared/assets.js';

enableAutoUnmount(afterEach);

describe('RichTextView figures', () => {
  it('opens each embedded figure with its resolved source and accessible label', async () => {
    const nodes: RichText = [
      { t: 'text', v: 'Vergleiche die Graphen.' },
      { t: 'fig', src: 'assets/a.png', alt: 'Graph A' },
      { t: 'math', v: 'f(x) = x^2' },
      { t: 'fig', src: 'assets/b.png', alt: 'Graph B' },
    ];
    const wrapper = mount(defineComponent({
      setup() {
        provideAssetResolver((src) => `/bank/revision/${src}`);
        return () => h(RichTextView, { nodes, inlineOnly: true });
      },
    }), { global: { stubs: { teleport: true, FigureViewer: true } } });

    const triggers = wrapper.findAll('button.q-zfig');
    expect(triggers).toHaveLength(2);
    expect(wrapper.text()).toContain('Vergleiche die Graphen.');
    expect(wrapper.find('.katex').exists()).toBe(true);
    for (const [index, letter] of ['A', 'B'].entries()) {
      const trigger = triggers[index]!;
      expect(trigger.attributes('aria-label')).toBe(`Graph ${letter} — vergrößern`);
      expect(trigger.attributes('aria-haspopup')).toBe('dialog');
      await trigger.trigger('click');
      const viewer = wrapper.findComponent(FigureViewer);
      expect(viewer.props('src')).toBe(`/bank/revision/assets/${letter.toLowerCase()}.png`);
      expect(viewer.props('alt')).toBe(`Graph ${letter}`);
      await viewer.vm.$emit('close');
      expect(wrapper.findComponent(FigureViewer).exists()).toBe(false);
    }
  });

  it('keeps prose without images free of preview controls', () => {
    const wrapper = mount(RichTextView, {
      props: { nodes: [{ t: 'text', v: 'Begründe deine Antwort.' }] },
    });
    expect(wrapper.text()).toBe('Begründe deine Antwort.');
    expect(wrapper.find('button').exists()).toBe(false);
  });
});
