import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import FigureViewer from '../src/shared/FigureViewer.vue';
import ZoomableFigure from '../src/shared/ZoomableFigure.vue';
import { bodyScrollLockDepth } from '../src/shared/scroll-lock.js';

const STAGE = { width: 400, height: 400, left: 0, top: 0 };
/** Layout size of the <img> before any transform — drives the pan clamp. */
const IMAGE = { width: 300, height: 200 };

/**
 * jsdom reports 0 for every box, so the viewer's clamp maths would have
 * nothing to work with. These stubs give the stage and the image a size.
 */
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const isImage = this.tagName === 'IMG';
    const box = isImage ? { width: IMAGE.width, height: IMAGE.height } : STAGE;
    return { ...STAGE, ...box, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  for (const [prop, value] of [
    ['offsetWidth', IMAGE.width],
    ['offsetHeight', IMAGE.height],
  ] as const) {
    Object.defineProperty(HTMLImageElement.prototype, prop, { value, configurable: true });
  }
  for (const [prop, value] of [
    ['clientWidth', STAGE.width],
    ['clientHeight', STAGE.height],
  ] as const) {
    Object.defineProperty(HTMLDivElement.prototype, prop, { value, configurable: true });
  }
}

function pointer(id: number, x: number, y: number): Record<string, unknown> {
  return { pointerId: id, clientX: x, clientY: y };
}

/** Drives the viewer's double-tap clock (Event.timeStamp is read-only). */
function fakeClock(): (ms: number) => void {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return (ms: number) => {
    now = ms;
  };
}

/** Teleport is stubbed so the overlay stays inside the wrapper's tree. */
const INLINE_TELEPORT = { global: { stubs: { teleport: true } } };

function mountViewer() {
  stubLayout();
  return mount(FigureViewer, {
    props: { src: '/figures/graph.png', alt: 'Graph von f' },
    attachTo: document.body,
    ...INLINE_TELEPORT,
  });
}

/**
 * Both readers re-query the wrapper on every call: a DOMWrapper captured once
 * keeps reporting the attributes it was created with.
 */
function styleOf(wrapper: ReturnType<typeof mountViewer>): string {
  return wrapper.get('.q-figview__img').attributes('style') ?? '';
}

function scaleOf(wrapper: ReturnType<typeof mountViewer>): number {
  return Number(/scale\(([\d.]+)\)/.exec(styleOf(wrapper))?.[1] ?? '1');
}

function translationOf(wrapper: ReturnType<typeof mountViewer>): string {
  return /translate\(([^)]*)\)/.exec(styleOf(wrapper))?.[1] ?? '';
}

describe('FigureViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('pinches to zoom about the midpoint of the two fingers', async () => {
    const wrapper = mountViewer();
    const img = wrapper.get('.q-figview__img');

    // Two fingers 100px apart, centred on the stage, spread to 200px.
    await img.trigger('pointerdown', pointer(1, 150, 200));
    await img.trigger('pointerdown', pointer(2, 250, 200));
    await img.trigger('pointermove', pointer(2, 350, 200));

    expect(scaleOf(wrapper)).toBeCloseTo(2, 5);
    expect(wrapper.get('.q-figview__scale').text()).toBe('200 %');
    wrapper.unmount();
  });

  it('clamps zoom to the maximum however far the fingers spread', async () => {
    const wrapper = mountViewer();
    const img = wrapper.get('.q-figview__img');

    await img.trigger('pointerdown', pointer(1, 190, 200));
    await img.trigger('pointerdown', pointer(2, 210, 200));
    await img.trigger('pointermove', pointer(2, 4000, 200));

    expect(scaleOf(wrapper)).toBe(8);
    wrapper.unmount();
  });

  it('toggles zoom on double-tap and back again', async () => {
    const at = fakeClock();
    const wrapper = mountViewer();
    const img = wrapper.get('.q-figview__img');

    const tapAt = async (time: number, x = 200, y = 200): Promise<void> => {
      at(time);
      await img.trigger('pointerdown', pointer(1, x, y));
      await img.trigger('pointerup', pointer(1, x, y));
    };

    await tapAt(1000);
    expect(scaleOf(wrapper)).toBe(1); // a single tap must not zoom
    await tapAt(1120);
    expect(scaleOf(wrapper)).toBe(2.5);

    await tapAt(5000);
    await tapAt(5120);
    expect(scaleOf(wrapper)).toBe(1);
    wrapper.unmount();
  });

  it('ignores two taps that are too far apart in time or space', async () => {
    const at = fakeClock();
    const wrapper = mountViewer();
    const img = wrapper.get('.q-figview__img');

    const tapAt = async (time: number, x = 200, y = 200): Promise<void> => {
      at(time);
      await img.trigger('pointerdown', pointer(1, x, y));
      await img.trigger('pointerup', pointer(1, x, y));
    };

    await tapAt(1000);
    await tapAt(1900); // 900 ms apart — a deliberate second look, not a gesture
    expect(scaleOf(wrapper)).toBe(1);

    await tapAt(2000, 340); // 140 px apart — two different spots
    expect(scaleOf(wrapper)).toBe(1);
    wrapper.unmount();
  });

  it('does not pan at 1x and cannot drag a zoomed figure off the stage', async () => {
    const wrapper = mountViewer();
    const img = wrapper.get('.q-figview__img');

    await img.trigger('pointerdown', pointer(1, 200, 200));
    await img.trigger('pointermove', pointer(1, 320, 260));
    expect(translationOf(wrapper)).toBe('0px, 0px');
    await img.trigger('pointerup', pointer(1, 320, 260));

    // Zoom in, then try to fling the figure far past its own edge. At scale 4
    // the image is 1200x800 in a 400x400 stage, so the pan stops at 400/200.
    await img.trigger('pointerdown', pointer(1, 190, 200));
    await img.trigger('pointerdown', pointer(2, 210, 200));
    await img.trigger('pointermove', pointer(2, 270, 200));
    await img.trigger('pointerup', pointer(2, 270, 200));
    expect(scaleOf(wrapper)).toBe(4);

    await img.trigger('pointermove', pointer(1, 9000, 9000));
    expect(translationOf(wrapper)).toBe('400px, 200px');
    wrapper.unmount();
  });

  it('locks the page behind it and releases the lock on close', async () => {
    const before = bodyScrollLockDepth();
    const wrapper = mountViewer();
    expect(bodyScrollLockDepth()).toBe(before + 1);

    await wrapper.get('.q-figview__close').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);

    wrapper.unmount();
    expect(bodyScrollLockDepth()).toBe(before);
  });

  it('closes on Escape and on a click beside the figure', async () => {
    const wrapper = mountViewer();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper.emitted('close')).toHaveLength(1);

    await wrapper.get('.q-figview__stage').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);
    wrapper.unmount();
  });
});

describe('ZoomableFigure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('opens the viewer for its own image and labels the trigger', async () => {
    stubLayout();
    const wrapper = mount(ZoomableFigure, {
      props: { src: '/figures/graph.png', alt: 'Graph von f' },
      attachTo: document.body,
      ...INLINE_TELEPORT,
    });

    expect(wrapper.get('button').attributes('aria-label')).toBe('Graph von f — vergrößern');
    expect(wrapper.find('.q-figview').exists()).toBe(false);

    await wrapper.get('button').trigger('click');
    expect(wrapper.get('.q-figview__img').attributes('src')).toBe('/figures/graph.png');

    await wrapper.findComponent(FigureViewer).vm.$emit('close');
    expect(wrapper.find('.q-figview').exists()).toBe(false);
    wrapper.unmount();
  });

  it('falls back to a generic label when the figure has no alt text', () => {
    stubLayout();
    const wrapper = mount(ZoomableFigure, { props: { src: '/figures/x.png' }, ...INLINE_TELEPORT });
    expect(wrapper.get('button').attributes('aria-label')).toBe('Abbildung vergrößern');
    wrapper.unmount();
  });
});
