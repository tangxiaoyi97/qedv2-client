import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import SolutionSheet from '../src/practice/SolutionSheet.vue';
import type { SheetDetent } from '../src/practice/sheet-detents.js';

const mounted: Array<{ unmount(): void }> = [];

function mountSheet(detent: SheetDetent = 'default') {
  const wrapper = mount(SolutionSheet, {
    attachTo: document.body,
    props: { solution: [], detent, handle: true },
    slots: {
      review: `
        <p class="reading">Read <span class="text">the explanation</span> here.</p>
        <button class="action"><span class="button-label">Continue</span></button>
        <a class="link" href="#more">More</a>
        <input class="answer" value="42">
        <textarea class="notes">Notes</textarea>
        <div class="editable" contenteditable="true">Edit</div>
        <div class="slider" role="slider" tabindex="0">Score</div>
        <div class="vertical" style="overflow-y: auto"><p class="nested-text">Long text</p></div>
        <div class="horizontal" style="overflow-x: auto"><code class="code">A wide formula</code></div>
      `,
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

type Sheet = ReturnType<typeof mountSheet>;
type Point = { identifier: number; clientX: number; clientY: number };
const point = (clientY: number, clientX = 100, identifier = 1): Point =>
  ({ identifier, clientX, clientY });
const heightOf = (wrapper: Sheet): number =>
  Number.parseFloat(wrapper.get<HTMLElement>('.q-ssheet').element.style.height);

/**
 * Dispatch through the DOM, including bubbling and native listener options;
 * invoking component methods would miss passive-listener and capture bugs.
 * jsdom has no touch scrolling/layout. Scroll positions and nested overflow
 * dimensions below are explicit browser-state fixtures, not a simulation of
 * native momentum or Safari's decision to make a touchmove uncancelable.
 */
async function touch(
  target: Element,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  touches: Point[],
  timeStamp: number,
  options: { cancelable?: boolean; changedTouches?: Point[] } = {},
): Promise<Event> {
  const event = new Event(type, { bubbles: true, cancelable: options.cancelable ?? true });
  const withTarget = (p: Point) => ({ ...p, target });
  Object.defineProperties(event, {
    touches: { value: touches.map(withTarget) },
    changedTouches: { value: (options.changedTouches ?? touches).map(withTarget) },
    timeStamp: { value: timeStamp },
  });
  target.dispatchEvent(event);
  await nextTick();
  return event;
}

async function pull(wrapper: Sheet, distance = 40, selector = '.text') {
  const target = wrapper.get(selector).element;
  await touch(target, 'touchstart', [point(200)], 100);
  const move = await touch(target, 'touchmove', [point(200 + distance)], 300);
  const end = await touch(target, 'touchend', [], 320, { changedTouches: [point(200 + distance)] });
  return { move, end };
}

function click(target: Element, detail = 1): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail });
  target.dispatchEvent(event);
  return event;
}

function selectText(wrapper: Sheet) {
  const range = document.createRange();
  range.selectNodeContents(wrapper.get('.text').element);
  window.getSelection()!.addRange(range);
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('SolutionSheet content edge pull', () => {
  it.each([
    ['default', 36, 'collapsed'],
    ['default', 50, 'collapsed'],
    ['full', 36, 'default'],
    ['full', 50, 'default'],
  ] as const)('moves %s down one detent after a %ipx pull', async (detent, distance, expected) => {
    const wrapper = mountSheet(detent);
    const target = wrapper.get('.text').element;
    const originalHeight = heightOf(wrapper);
    await touch(target, 'touchstart', [point(200)], 100);
    const move = await touch(target, 'touchmove', [point(200 + distance)], 300);

    expect(move.defaultPrevented).toBe(true);
    expect(heightOf(wrapper)).toBe(originalHeight - distance);
    expect(wrapper.emitted('update:detent')).toBeUndefined();

    await touch(target, 'touchend', [], 320, { changedTouches: [point(200 + distance)] });
    expect(wrapper.emitted('update:detent')).toEqual([[expected]]);
    expect(wrapper.get('.q-ssheet').classes()).not.toContain('q-ssheet--dragging');
  });

  it('keeps normal scrolling inside the content native', async () => {
    const wrapper = mountSheet();
    const sheet = wrapper.get('.q-ssheet').element;
    sheet.scrollTop = 150;
    const initialHeight = heightOf(wrapper);
    const { move, end } = await pull(wrapper, 50);

    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(sheet.scrollTop).toBe(150);
    expect(heightOf(wrapper)).toBe(initialHeight);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it.each([10, 40])('counts only the extra %ipx after native scrolling reaches the edge', async (extra) => {
    const wrapper = mountSheet();
    const sheet = wrapper.get('.q-ssheet').element;
    const target = wrapper.get('.text').element;
    const initialHeight = heightOf(wrapper);
    sheet.scrollTop = 100;
    await touch(target, 'touchstart', [point(100)], 100);
    sheet.scrollTop = 20;
    expect((await touch(target, 'touchmove', [point(180)], 200)).defaultPrevented).toBe(false);
    sheet.scrollTop = 0;
    expect((await touch(target, 'touchmove', [point(220)], 300)).defaultPrevented).toBe(false);
    expect(heightOf(wrapper)).toBe(initialHeight);

    expect((await touch(target, 'touchmove', [point(220 + extra)], 500)).defaultPrevented).toBe(true);
    expect(heightOf(wrapper)).toBe(initialHeight - extra);
    await touch(target, 'touchend', [], 520, { changedTouches: [point(220 + extra)] });
    expect(wrapper.emitted('update:detent')).toEqual(extra === 40 ? [['collapsed']] : undefined);
  });

  it('does not try to take an uncancelable scroll gesture from the browser', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    const initialHeight = heightOf(wrapper);
    await touch(target, 'touchstart', [point(200)], 100);
    const nativeMove = await touch(target, 'touchmove', [point(240)], 200, { cancelable: false });
    // Losing ownership lasts until the finger is lifted, even if a later
    // synthetic/browser event happens to become cancelable again.
    const laterMove = await touch(target, 'touchmove', [point(280)], 300);
    await touch(target, 'touchend', [], 320, { changedTouches: [point(280)] });
    expect(nativeMove.defaultPrevented).toBe(false);
    expect(laterMove.defaultPrevented).toBe(false);
    expect(heightOf(wrapper)).toBe(initialHeight);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it.each([
    ['upward', point(140)],
    ['sideways', point(205, 160)],
  ])('preserves a %s reading gesture', async (_direction, end) => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    const initialHeight = heightOf(wrapper);
    await touch(target, 'touchstart', [point(200)], 100);
    expect((await touch(target, 'touchmove', [end as Point], 300)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [], 320, { changedTouches: [end as Point] });
    expect(heightOf(wrapper)).toBe(initialHeight);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('does not reclaim a sideways gesture when the finger turns downward', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    await touch(target, 'touchstart', [point(200)], 100);
    await touch(target, 'touchmove', [point(205, 160)], 200);
    expect((await touch(target, 'touchmove', [point(290, 160)], 300)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [], 320, { changedTouches: [point(290, 160)] });
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('does not open the collapsed sheet from its hidden content', async () => {
    const wrapper = mountSheet('collapsed');
    expect((await pull(wrapper)).move.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });
});

describe('SolutionSheet reading controls', () => {
  it.each(['.button-label', '.link', '.answer', '.notes', '.editable', '.slider'])(
    'leaves a gesture starting on %s to the control', async (selector) => {
      const wrapper = mountSheet();
      const { move, end } = await pull(wrapper, 50, selector);
      expect(move.defaultPrevented).toBe(false);
      expect(end.defaultPrevented).toBe(false);
      expect(wrapper.emitted('update:detent')).toBeUndefined();
    },
  );

  it('preserves scrolling a nested text area before its own top edge', async () => {
    const wrapper = mountSheet();
    wrapper.get('.vertical').element.scrollTop = 80;
    expect((await pull(wrapper, 50, '.nested-text')).move.defaultPrevented).toBe(false);
    expect(wrapper.get('.vertical').element.scrollTop).toBe(80);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('preserves a horizontally scrollable formula even at its left edge', async () => {
    const wrapper = mountSheet();
    Object.defineProperties(wrapper.get('.horizontal').element, {
      clientWidth: { value: 180, configurable: true },
      scrollWidth: { value: 640, configurable: true },
    });
    expect((await pull(wrapper, 50, '.code')).move.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('preserves an existing text selection', async () => {
    const wrapper = mountSheet();
    selectText(wrapper);
    expect((await pull(wrapper)).move.defaultPrevented).toBe(false);
    expect(window.getSelection()?.toString()).toBe('the explanation');
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('cancels a pull when a text selection appears during the gesture', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    const initialHeight = heightOf(wrapper);
    await touch(target, 'touchstart', [point(200)], 100);
    await touch(target, 'touchmove', [point(240)], 200);
    selectText(wrapper);
    expect((await touch(target, 'touchmove', [point(250)], 300)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [], 320, { changedTouches: [point(250)] });
    expect(heightOf(wrapper)).toBe(initialHeight);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('leaves a two-finger pinch native', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    await touch(target, 'touchstart', [point(200), point(220, 180, 2)], 100);
    expect((await touch(target, 'touchmove', [point(240), point(270, 210, 2)], 200)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [], 300, { changedTouches: [point(240), point(270, 210, 2)] });
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('abandons an already claimed pull when a second finger joins', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    const initialHeight = heightOf(wrapper);
    await touch(target, 'touchstart', [point(200)], 100);
    await touch(target, 'touchmove', [point(240)], 200);
    await touch(target, 'touchstart', [point(240), point(220, 180, 2)], 250, { changedTouches: [point(220, 180, 2)] });
    expect((await touch(target, 'touchmove', [point(250), point(270, 210, 2)], 300)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [point(250)], 350, { changedTouches: [point(270, 210, 2)] });
    expect((await touch(target, 'touchmove', [point(290)], 400)).defaultPrevented).toBe(false);
    await touch(target, 'touchend', [], 420, { changedTouches: [point(290)] });
    expect(heightOf(wrapper)).toBe(initialHeight);
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });
});

describe('SolutionSheet interrupted content pull', () => {
  it.each(['touchcancel', 'blur', 'resize', 'external detent', 'uncancelable move'])(
    'does not commit after %s', async (reason) => {
      const wrapper = mountSheet();
      const target = wrapper.get('.text').element;
      const initialHeight = heightOf(wrapper);
      await touch(target, 'touchstart', [point(200)], 100);
      await touch(target, 'touchmove', [point(240)], 200);
      expect(heightOf(wrapper)).toBe(initialHeight - 40);

      if (reason === 'touchcancel') await touch(target, 'touchcancel', [], 250);
      else if (reason === 'external detent') await wrapper.setProps({ detent: 'full' });
      else if (reason === 'uncancelable move') {
        await touch(target, 'touchmove', [point(250)], 250, { cancelable: false });
      } else {
        window.dispatchEvent(new Event(reason));
        await nextTick();
      }
      expect(wrapper.get('.q-ssheet').classes()).not.toContain('q-ssheet--dragging');
      expect((await touch(target, 'touchmove', [point(280)], 300)).defaultPrevented).toBe(false);
      await touch(target, 'touchend', [], 320, { changedTouches: [point(280)] });
      expect(wrapper.emitted('update:detent')).toBeUndefined();
      if (reason !== 'external detent') expect(heightOf(wrapper)).toBe(initialHeight);
      else expect(heightOf(wrapper)).toBeGreaterThan(initialHeight);
    },
  );
});

describe('SolutionSheet content clicks after touch', () => {
  it('suppresses a drag’s trailing click before it activates content', async () => {
    const wrapper = mountSheet('full');
    const target = wrapper.get('.text').element;
    const activated = vi.fn();
    target.addEventListener('click', activated);
    await pull(wrapper);

    expect(click(target).defaultPrevented).toBe(true);
    expect(activated).not.toHaveBeenCalled();
    expect(wrapper.emitted('update:detent')).toEqual([['default']]);
  });

  it('keeps an ordinary content tap clickable', async () => {
    const wrapper = mountSheet();
    const target = wrapper.get('.text').element;
    const activated = vi.fn();
    target.addEventListener('click', activated);
    await touch(target, 'touchstart', [point(200)], 100);
    await touch(target, 'touchend', [], 120, { changedTouches: [point(200)] });

    expect(click(target).defaultPrevented).toBe(false);
    expect(activated).toHaveBeenCalledOnce();
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('lets the next fresh tap activate a button immediately after a drag', async () => {
    const wrapper = mountSheet('full');
    const button = wrapper.get('.action').element;
    const activated = vi.fn();
    button.addEventListener('click', activated);
    await pull(wrapper);
    await touch(button, 'touchstart', [point(200)], 330);
    await touch(button, 'touchend', [], 350, { changedTouches: [point(200)] });

    expect(click(button).defaultPrevented).toBe(false);
    expect(activated).toHaveBeenCalledOnce();
  });

  it('does not swallow keyboard activation while a drag click is pending', async () => {
    const wrapper = mountSheet('full');
    const button = wrapper.get('.action').element;
    const activated = vi.fn();
    button.addEventListener('click', activated);
    await pull(wrapper);

    expect(click(button, 0).defaultPrevented).toBe(false);
    expect(activated).toHaveBeenCalledOnce();
  });

  it('does not consume the handle’s next explicit click after a content drag', async () => {
    const wrapper = mountSheet('full');
    await pull(wrapper);
    await wrapper.setProps({ detent: 'default' });
    await wrapper.get('.q-ssheet__handle').trigger('click');
    expect(wrapper.emitted('update:detent')).toEqual([['default'], ['collapsed']]);
  });
});
