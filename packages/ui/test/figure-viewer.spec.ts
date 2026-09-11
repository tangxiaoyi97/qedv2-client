import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import FigureViewer from '../src/shared/FigureViewer.vue';
import ZoomableFigure from '../src/shared/ZoomableFigure.vue';
import PracticeHelpDialog from '../src/practice/PracticeHelpDialog.vue';
import { bodyScrollLockDepth } from '../src/shared/scroll-lock.js';

const views: VueWrapper[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function track<T extends VueWrapper>(view: T): T {
  views.push(view);
  return view;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  // Removing DOM alone leaves document listeners, focus frames and locks alive.
  for (const view of views.splice(0).reverse()) {
    if (!view.vm.$.isUnmounted) view.unmount();
  }
  frames.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  expect(bodyScrollLockDepth()).toBe(0);
});

function runFrames(): void {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach(callback => callback(0));
}

function key(value: string, shiftKey = false): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
}

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
    ['naturalWidth', IMAGE.width],
    ['naturalHeight', IMAGE.height],
  ] as const) {
    vi.spyOn(HTMLImageElement.prototype, prop, 'get').mockReturnValue(value);
  }
  for (const [prop, value] of [
    ['clientWidth', STAGE.width],
    ['clientHeight', STAGE.height],
  ] as const) {
    vi.spyOn(HTMLDivElement.prototype, prop, 'get').mockReturnValue(value);
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
  return track(mount(FigureViewer, {
    props: { src: '/figures/graph.png', alt: 'Graph von f' },
    attachTo: document.body,
    ...INLINE_TELEPORT,
  }));
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
  it('reclamps a zoomed figure after layout changes without changing scale or jumping on the next drag', async () => {
    let resize = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe = observe;
      disconnect = disconnect;
    });
    try {
      const wrapper = mountViewer();
      const img = wrapper.get('.q-figview__img');
      expect(observe.mock.calls.map(call => call[0])).toEqual([
        wrapper.get('.q-figview__stage').element, img.element,
      ]);
      wrapper.get('.q-figview__stage').element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaY: -400 * Math.log(4), clientX: 200, clientY: 200,
      }));
      await nextTick();
      await img.trigger('pointerdown', pointer(1, 200, 200));
      await img.trigger('pointermove', pointer(1, 900, 900));
      expect(translationOf(wrapper)).toBe('400px, 200px');

      // Rotation changes both the fitting image and available reading area.
      vi.spyOn(HTMLImageElement.prototype, 'offsetWidth', 'get').mockReturnValue(150);
      vi.spyOn(HTMLImageElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
      vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
      vi.spyOn(HTMLDivElement.prototype, 'clientHeight', 'get').mockReturnValue(250);
      resize();
      await nextTick();
      expect(scaleOf(wrapper)).toBe(4);
      expect(translationOf(wrapper)).toBe('200px, 75px');
      await img.trigger('pointermove', pointer(1, 890, 890));
      expect(translationOf(wrapper)).toBe('190px, 65px');
      wrapper.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('waits for real image dimensions before limiting a pending image on load or resize', async () => {
    const wrapper = mountViewer();
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(0);
    vi.spyOn(HTMLImageElement.prototype, 'offsetWidth', 'get').mockReturnValue(0);
    vi.spyOn(HTMLImageElement.prototype, 'offsetHeight', 'get').mockReturnValue(0);
    wrapper.get('.q-figview__stage').element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: -400 * Math.log(4), clientX: 100, clientY: 150,
    }));
    await nextTick();
    expect(translationOf(wrapper)).toBe('300px, 150px');
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    expect(translationOf(wrapper)).toBe('300px, 150px');

    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(400);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLImageElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLImageElement.prototype, 'offsetHeight', 'get').mockReturnValue(50);
    await wrapper.get('.q-figview__img').trigger('load');
    expect(scaleOf(wrapper)).toBe(4);
    expect(translationOf(wrapper)).toBe('0px, 0px');
  });

  it('initially focuses close and traps both directions of Tab inside the viewer', async () => {
    const wrapper = mountViewer();
    runFrames();
    const close = wrapper.get('.q-figview__close').element;
    const first = wrapper.get('button[aria-label="Vergrößern"]').element as HTMLButtonElement;
    const last = wrapper.get('.q-figview__stage').element as HTMLElement;
    expect(document.activeElement).toBe(close);
    last.focus();
    key('Tab');
    expect(document.activeElement).toBe(first);
    key('Tab', true);
    expect(document.activeElement).toBe(last);

    // Once zoomed, the now-enabled minus button becomes the first tab stop.
    await wrapper.get('button[aria-label="Vergrößern"]').trigger('click');
    last.focus();
    key('Tab');
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="Verkleinern"]').element);
  });

  it.each(['Escape', 'close button'])('closes only the viewer nested inside help via %s and restores focus and locks', async (closeVia) => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const Host = defineComponent({
      components: { PracticeHelpDialog, ZoomableFigure },
      setup: () => ({ helpOpen: ref(true) }),
      template: `<PracticeHelpDialog v-if="helpOpen" title="KI-Erklärung" return-label="Zurück" @close="helpOpen = false">
        <ZoomableFigure src="/figures/graph.png" alt="Graph von f" />
      </PracticeHelpDialog>`,
    });
    // Real Teleports and a real parent modal exercise document listener order.
    const wrapper = track(mount(Host, { attachTo: document.body }));
    runFrames();
    const help = wrapper.getComponent(PracticeHelpDialog);
    const imageTrigger = document.querySelector<HTMLButtonElement>('.practice-help .q-zfig')!;
    expect(bodyScrollLockDepth()).toBe(1);
    imageTrigger.focus();
    imageTrigger.click();
    await nextTick();
    runFrames();
    const close = document.querySelector<HTMLButtonElement>('.q-figview__close')!;
    expect(document.activeElement).toBe(close);
    expect(bodyScrollLockDepth()).toBe(2);

    // The parent's trap must not intercept Tab from its teleported child.
    document.querySelector<HTMLElement>('.q-figview__stage')!.focus();
    key('Tab');
    expect(document.activeElement).toBe(document.querySelector('.q-figview button[aria-label="Vergrößern"]'));
    if (closeVia === 'Escape') key('Escape');
    else close.click();
    await nextTick();
    expect(document.querySelector('.q-figview')).toBeNull();
    expect(document.querySelector('.practice-help')).not.toBeNull();
    expect(help.emitted('close')).toBeUndefined();
    expect(document.activeElement).toBe(imageTrigger);
    expect(bodyScrollLockDepth()).toBe(1);
    expect(document.body.classList.contains('q-modal-open')).toBe(true);

    key('Escape');
    await nextTick();
    expect(document.querySelector('.practice-help')).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(bodyScrollLockDepth()).toBe(0);
    expect(document.body.classList.contains('q-modal-open')).toBe(false);
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

  it('offers zoom as controls rather than as a caption telling you to pinch', async () => {
    // The gesture list along the bottom named three things the user might do
    // and gave them none of them — and cost the figure a strip of screen on
    // devices that cannot pinch at all.
    const wrapper = mountViewer();
    expect(wrapper.find('.q-figview__hint').exists()).toBe(false);
    expect(wrapper.findAll('.q-figview__zoom-btn')).toHaveLength(2);

    const [out, into] = wrapper.findAll('.q-figview__zoom-btn');
    // Nothing to shrink or reset at 1x, but both controls keep their place so
    // the bar does not reflow the moment you zoom.
    expect(out!.attributes('disabled')).toBeDefined();
    expect(wrapper.get('.q-figview__reset').attributes('disabled')).toBeDefined();

    await into!.trigger('click');
    expect(scaleOf(wrapper)).toBeCloseTo(1.5, 5);
    expect(wrapper.get('.q-figview__reset').attributes('disabled')).toBeUndefined();

    await wrapper.get('.q-figview__zoom-btn').trigger('click');
    expect(scaleOf(wrapper)).toBeCloseTo(1, 5);
  });

  it('zooms and pans from the keyboard', async () => {
    // Pinch, double-tap and wheel between them left a keyboard user able to do
    // nothing here but close the one screen that exists to look closer.
    const wrapper = mountViewer();
    const stage = wrapper.get('.q-figview__stage');

    await stage.trigger('keydown', { key: '+' });
    expect(scaleOf(wrapper)).toBeCloseTo(1.5, 5);
    await stage.trigger('keydown', { key: '-' });
    expect(scaleOf(wrapper)).toBeCloseTo(1, 5);

    // At 1x there is nothing to pan, so arrows must not shift anything.
    await stage.trigger('keydown', { key: 'ArrowRight' });
    expect(translationOf(wrapper)).toBe('0px, 0px');

    await stage.trigger('keydown', { key: '+' });
    await stage.trigger('keydown', { key: 'ArrowRight' });
    expect(translationOf(wrapper)).not.toBe('0px, 0px');

    await stage.trigger('keydown', { key: '0' });
    expect(scaleOf(wrapper)).toBeCloseTo(1, 5);
    expect(translationOf(wrapper)).toBe('0px, 0px');
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
  it('opens the viewer for its own image and labels the trigger', async () => {
    stubLayout();
    const wrapper = track(mount(ZoomableFigure, {
      props: { src: '/figures/graph.png', alt: 'Graph von f' },
      attachTo: document.body,
      ...INLINE_TELEPORT,
    }));

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
    const wrapper = track(mount(ZoomableFigure, { props: { src: '/figures/x.png' }, ...INLINE_TELEPORT }));
    expect(wrapper.get('button').attributes('aria-label')).toBe('Abbildung vergrößern');
    wrapper.unmount();
  });

  it('opens its dialog without activating an enclosing answer option', async () => {
    const onChoice = vi.fn();
    const Host = defineComponent({
      components: { ZoomableFigure },
      setup: () => ({ onChoice }),
      template: '<div @click="onChoice"><ZoomableFigure src="/figures/x.png" /></div>',
    });
    const wrapper = track(mount(Host, { attachTo: document.body, ...INLINE_TELEPORT }));
    const trigger = wrapper.get('.q-zfig');
    expect(trigger.attributes('aria-haspopup')).toBe('dialog');
    await trigger.trigger('click');
    expect(wrapper.find('.q-figview').exists()).toBe(true);
    expect(onChoice).not.toHaveBeenCalled();
  });

  it('ignores a scroll gesture ending on the image and accepts the next deliberate click', async () => {
    const wrapper = track(mount(ZoomableFigure, {
      props: { src: '/figures/x.png' }, attachTo: document.body, ...INLINE_TELEPORT,
    }));
    const trigger = wrapper.get('.q-zfig');
    await trigger.trigger('pointerdown', { ...pointer(1, 200, 200), pointerType: 'touch', isPrimary: true, button: 0 });
    await trigger.trigger('pointermove', pointer(1, 180, 150));
    await trigger.trigger('pointerup', pointer(1, 180, 150));
    trigger.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await nextTick();
    expect(wrapper.find('.q-figview').exists()).toBe(false);

    await trigger.trigger('pointerdown', { ...pointer(2, 200, 200), pointerType: 'touch', isPrimary: true, button: 0 });
    await trigger.trigger('pointerup', pointer(2, 200, 200));
    trigger.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await nextTick();
    expect(wrapper.find('.q-figview').exists()).toBe(true);
  });
});
