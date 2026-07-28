import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SolutionSheet from '../src/practice/SolutionSheet.vue';

/**
 * The drawer has three detents. Dragging the handle moves it with the finger
 * and snaps to the nearest one; clicking only ever toggles shut ↔ reading
 * height, so a stray tap can never bury the question under a full-screen
 * solution.
 */

// jsdom reports 768px, which fixes the detents this spec reasons about.
const VIEWPORT = 768;
const HEIGHTS = { collapsed: 0, default: 420, full: VIEWPORT - 96 };

function mountSheet(props: Record<string, unknown> = {}) {
  return mount(SolutionSheet, {
    props: { solution: [], detent: 'collapsed' as const, handle: true, ...props },
  });
}

const at = (y: number) => ({ clientY: y, pointerId: 1 });

/** Drag from `startY` to `endY` and release. */
async function drag(
  wrapper: ReturnType<typeof mountSheet>,
  startY: number,
  endY: number,
): Promise<void> {
  const handle = wrapper.get('.q-ssheet__handle');
  await handle.trigger('pointerdown', at(startY));
  await handle.trigger('pointermove', at(endY));
  await handle.trigger('pointerup', at(endY));
}

const heightOf = (wrapper: ReturnType<typeof mountSheet>): number =>
  Number(/height:\s*([\d.]+)px/.exec(wrapper.get('.q-ssheet').attributes('style') ?? '')?.[1] ?? -1);

const lastDetent = (wrapper: ReturnType<typeof mountSheet>): string | undefined =>
  wrapper.emitted('update:detent')?.at(-1)?.[0] as string | undefined;

describe('SolutionSheet detents', () => {
  it('sizes itself from the detent it is given', () => {
    expect(heightOf(mountSheet({ detent: 'collapsed' }))).toBe(HEIGHTS.collapsed);
    expect(heightOf(mountSheet({ detent: 'default' }))).toBe(HEIGHTS.default);
    expect(heightOf(mountSheet({ detent: 'full' }))).toBe(HEIGHTS.full);
  });

  it('keeps the handle reachable while the sheet is shut', () => {
    const wrapper = mountSheet({ detent: 'collapsed' });
    expect(wrapper.find('.q-ssheet__handle').exists()).toBe(true);
    expect(wrapper.get('.q-ssheet').classes()).not.toContain('q-ssheet--open');
  });

  it('is absent while the question is still unanswered', () => {
    expect(mountSheet({ handle: false }).find('.q-ssheet__handle').exists()).toBe(false);
  });
});

describe('SolutionSheet click', () => {
  it('toggles between shut and the reading height', async () => {
    const shut = mountSheet({ detent: 'collapsed' });
    await shut.get('.q-ssheet__handle').trigger('click');
    expect(lastDetent(shut)).toBe('default');

    const open = mountSheet({ detent: 'default' });
    await open.get('.q-ssheet__handle').trigger('click');
    expect(lastDetent(open)).toBe('collapsed');
  });

  it('never reaches full screen — that detent is the swipe’s alone', async () => {
    for (const detent of ['collapsed', 'default', 'full'] as const) {
      const wrapper = mountSheet({ detent });
      await wrapper.get('.q-ssheet__handle').trigger('click');
      expect(lastDetent(wrapper), detent).not.toBe('full');
    }
  });

  it('collapses from full screen in one tap', async () => {
    const wrapper = mountSheet({ detent: 'full' });
    await wrapper.get('.q-ssheet__handle').trigger('click');
    expect(lastDetent(wrapper)).toBe('collapsed');
  });
});

describe('SolutionSheet drag', () => {
  it('tracks the finger one-to-one and suspends its transition', async () => {
    const wrapper = mountSheet({ detent: 'default' });
    const handle = wrapper.get('.q-ssheet__handle');
    await handle.trigger('pointerdown', at(500));
    await handle.trigger('pointermove', at(400)); // 100px up

    // Attached to the finger, not easing towards it.
    expect(heightOf(wrapper)).toBe(HEIGHTS.default + 100);
    expect(wrapper.get('.q-ssheet').classes()).toContain('q-ssheet--dragging');

    await handle.trigger('pointerup', at(400));
    // Released: back under the transition so the snap is eased.
    expect(wrapper.get('.q-ssheet').classes()).not.toContain('q-ssheet--dragging');
  });

  it('reaches full screen by swiping up from the reading height', async () => {
    const wrapper = mountSheet({ detent: 'default' });
    await drag(wrapper, 500, 280); // +220 → 640, nearest is full (672)
    expect(lastDetent(wrapper)).toBe('full');
  });

  it('snaps to the nearest detent rather than the nearest edge', async () => {
    const up = mountSheet({ detent: 'collapsed' });
    await drag(up, 500, 200); // +300 → nearest is default (420), not full
    expect(lastDetent(up)).toBe('default');

    const down = mountSheet({ detent: 'full' });
    await drag(down, 200, 400); // −200 → 472, nearest is default
    expect(lastDetent(down)).toBe('default');

    const shut = mountSheet({ detent: 'default' });
    await drag(shut, 200, 500); // −300 → 120, nearest is collapsed
    expect(lastDetent(shut)).toBe('collapsed');
  });

  it('cannot be dragged past full screen or below shut', async () => {
    const over = mountSheet({ detent: 'default' });
    const overHandle = over.get('.q-ssheet__handle');
    await overHandle.trigger('pointerdown', at(700));
    await overHandle.trigger('pointermove', at(-4000));
    expect(heightOf(over)).toBe(HEIGHTS.full);

    const under = mountSheet({ detent: 'default' });
    const underHandle = under.get('.q-ssheet__handle');
    await underHandle.trigger('pointerdown', at(100));
    await underHandle.trigger('pointermove', at(4000));
    expect(heightOf(under)).toBe(0);
  });

  it('ignores a twitch too small to be a swipe', async () => {
    const wrapper = mountSheet({ detent: 'collapsed' });
    const handle = wrapper.get('.q-ssheet__handle');
    await handle.trigger('pointerdown', at(300));
    await handle.trigger('pointermove', at(295));
    await handle.trigger('pointerup', at(295));
    expect(wrapper.emitted('update:detent')).toBeUndefined();
  });

  it('does not let the trailing click undo the swipe', async () => {
    const wrapper = mountSheet({ detent: 'collapsed' });
    await drag(wrapper, 500, 200);
    await wrapper.get('.q-ssheet__handle').trigger('click');
    expect(wrapper.emitted('update:detent')).toEqual([['default']]);
  });
});

describe('SolutionSheet verdict', () => {
  it('shows the result inside the sheet without tinting the surface', () => {
    const wrapper = mountSheet({
      detent: 'default',
      verdict: 'incorrect',
      verdictLabel: 'Falsch',
      verdictPoints: '0 / 1 P',
    });
    const verdict = wrapper.get('.q-ssheet__verdict');
    expect(verdict.text()).toContain('Falsch');
    expect(verdict.text()).toContain('0 / 1 P');
    // Colour-coding the drawer and the bar was removed; only the grip carries it.
    expect(wrapper.get('.q-ssheet-wrap').classes()).toEqual(['q-ssheet-wrap']);
  });

  it('carries the result on the grip, which survives collapsing', () => {
    // Shut, the grip is the only thing still on screen — so it is where the
    // „right or wrong" cue has to live.
    for (const verdict of ['correct', 'partial', 'incorrect'] as const) {
      const wrapper = mountSheet({ detent: 'collapsed', verdict });
      expect(wrapper.get('.q-ssheet__grip').classes(), verdict).toContain(
        `q-ssheet__grip--${verdict}`,
      );
    }
  });

  it('leaves the grip neutral until there is a result', () => {
    const wrapper = mountSheet({ detent: 'collapsed' });
    expect(wrapper.get('.q-ssheet__grip').classes()).toContain('q-ssheet__grip--neutral');
  });

  it('names the verdict in the handle so the cue is not colour-only', () => {
    const wrapper = mountSheet({
      detent: 'collapsed',
      verdict: 'incorrect',
      verdictLabel: 'Falsch',
    });
    expect(wrapper.get('.q-ssheet__handle').attributes('aria-label')).toBe(
      'Falsch — Lösung anzeigen',
    );

    const plain = mountSheet({ detent: 'collapsed' });
    expect(plain.get('.q-ssheet__handle').attributes('aria-label')).toBe('Lösung anzeigen');
  });
});
