import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FigureList from '../src/shared/FigureList.vue';

describe('FigureList', () => {
  it('renders standalone image figures and ignores unsupported figure kinds', () => {
    const wrapper = mount(FigureList, {
      props: {
        figures: [
          { kind: 'image', src: 'assets/fig/question.png', alt: 'Funktionsgraph' },
          { kind: 'geogebra', id: 'ignored-in-v1' },
        ],
      },
    });

    const images = wrapper.findAll('img.q-zfig__img');
    expect(images).toHaveLength(1);
    expect(images[0]!.attributes('src')).toBe('assets/fig/question.png');
    expect(images[0]!.attributes('alt')).toBe('Funktionsgraph');
    expect(images[0]!.attributes('loading')).toBe('lazy');
  });

  it('makes every figure openable in the zoom viewer', () => {
    // Browser zoom is disabled app-wide, so this trigger is the only way to
    // read a dense graph on a phone — it must survive refactors of the list.
    const wrapper = mount(FigureList, {
      props: { figures: [{ kind: 'image', src: 'assets/fig/question.png', alt: 'Funktionsgraph' }] },
    });

    const trigger = wrapper.get('button.q-zfig');
    expect(trigger.attributes('aria-label')).toBe('Funktionsgraph — vergrößern');
  });
});
