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

    const images = wrapper.findAll('img.q-figures__image');
    expect(images).toHaveLength(1);
    expect(images[0]!.attributes('src')).toBe('assets/fig/question.png');
    expect(images[0]!.attributes('alt')).toBe('Funktionsgraph');
    expect(images[0]!.attributes('loading')).toBe('lazy');
  });
});
