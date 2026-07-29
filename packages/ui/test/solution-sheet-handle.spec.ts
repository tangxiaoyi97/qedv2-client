import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SolutionSheet from '../src/practice/SolutionSheet.vue';
import { FULL_OVERSHOOT_PX, TOP_BAR_RESERVE_PX } from '../src/practice/sheet-detents.js';

/**
 * The drawer has three detents. Dragging the handle moves it with the finger
 * and snaps to the nearest one; clicking only ever toggles shut ↔ reading
 * height, so a stray tap can never bury the question under a full-screen
 * solution.
 */

// jsdom reports 768px and has no layout, so the half detent falls back to its
// ratio estimate instead of the measured answer height.
const VIEWPORT = 768;
const HEIGHTS = {
  collapsed: 0,
  default: Math.round(Math.min(VIEWPORT * 0.55, 460)),
  full: VIEWPORT - TOP_BAR_RESERVE_PX + FULL_OVERSHOOT_PX,
};

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

  it('rules a line under the grip while the sheet is shut', () => {
    // Shut, the sheet is zero-height and its own bottom rule draws nothing —
    // without this the grip floats straight on top of the action buttons.
    expect(mountSheet({ detent: 'collapsed' }).get('.q-ssheet__top').classes()).toContain(
      'q-ssheet__top--closed',
    );
    for (const detent of ['default', 'full'] as const) {
      expect(mountSheet({ detent }).get('.q-ssheet__top').classes()).not.toContain(
        'q-ssheet__top--closed',
      );
    }
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

describe('SolutionSheet half-open size', () => {
  /** Stub a viewport height and remount, since detents derive from it. */
  function atViewport(height: number, props: Record<string, unknown> = {}) {
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
    return mountSheet(props);
  }

  // Restoring inline after the assertions would leak the stubbed viewport into
  // every later test in this file the moment one expectation fails.
  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: VIEWPORT, configurable: true });
  });

  it('never opens further than 60 % of a short viewport', () => {
    const wrapper = atViewport(600, { detent: 'default' });
    expect(heightOf(wrapper)).toBeLessThanOrEqual(Math.round(600 * 0.6));
  });

  it('is capped in absolute pixels on a tall viewport', () => {
    // Without the cap a desktop-height window would hand the "half" detent
    // most of the screen, which is what `full` is for.
    const wrapper = atViewport(2000, { detent: 'default' });
    expect(heightOf(wrapper)).toBe(460);
  });

  it('never grows past the full detent, however cramped the viewport', () => {
    const wrapper = atViewport(200, { detent: 'default' });
    const full = 200 - TOP_BAR_RESERVE_PX + FULL_OVERSHOOT_PX;
    expect(heightOf(wrapper)).toBeLessThanOrEqual(full);
  });

  it('wraps the answer in a measurable block that excludes the grading note', () => {
    // The block's bottom is what the measurement reads; jsdom cannot lay out,
    // so this guards the structure rather than the resulting pixels — the
    // numbers are covered in sheet-detents.spec.ts.
    const wrapper = mountSheet({
      detent: 'default',
      solution: [
        {
          result: [{ t: 'text', v: 'Zutreffend: A' }],
          note: 'Ein Punkt für vier richtige Zuordnungen.',
        },
      ],
    });
    const answer = wrapper.get('.q-ssheet__answer');
    expect(answer.find('.q-ssheet__card').exists()).toBe(true);
    expect(answer.find('.q-ssheet__note').exists()).toBe(false);

    const html = wrapper.html();
    expect(html.indexOf('q-ssheet__answer')).toBeLessThan(html.indexOf('q-ssheet__note'));
  });
});

describe('SolutionSheet banner', () => {
  const withVerdict = (detent: string) =>
    mountSheet({ detent, verdict: 'incorrect', verdictLabel: 'Falsch', verdictPoints: '0 / 1 P' });

  it('merges grip and result into one tinted banner at full screen', () => {
    const wrapper = withVerdict('full');
    expect(wrapper.get('.q-ssheet__top').classes()).toContain('q-ssheet__top--incorrect');
    const banner = wrapper.get('.q-ssheet__banner');
    expect(banner.text()).toContain('Falsch');
    expect(banner.text()).toContain('0 / 1 P');
    // Moved out of the scrolling body, so it cannot scroll away.
    expect(wrapper.find('.q-ssheet__verdict').exists()).toBe(false);
  });

  it('keeps the header neutral and the verdict in the body below full screen', () => {
    for (const detent of ['collapsed', 'default'] as const) {
      const wrapper = withVerdict(detent);
      // No verdict tint — the header may still carry layout modifiers of its
      // own, so name the classes that must be absent rather than the whole set.
      const classes = wrapper.get('.q-ssheet__top').classes();
      for (const tint of ['correct', 'partial', 'incorrect']) {
        expect(classes, detent).not.toContain(`q-ssheet__top--${tint}`);
      }
      expect(wrapper.find('.q-ssheet__banner').exists(), detent).toBe(false);
      expect(wrapper.get('.q-ssheet__verdict').text(), detent).toContain('Falsch');
    }
  });

  it('drops the grip’s own colour once the banner carries it', () => {
    // Verdict-on-verdict would make the grip disappear into the banner.
    expect(withVerdict('full').get('.q-ssheet__grip').classes()).toContain(
      'q-ssheet__grip--on-banner',
    );
    expect(withVerdict('default').get('.q-ssheet__grip').classes()).toContain(
      'q-ssheet__grip--incorrect',
    );
  });

  it('shows no banner when there is no result to show', () => {
    const wrapper = mountSheet({ detent: 'full' });
    expect(wrapper.find('.q-ssheet__banner').exists()).toBe(false);
    expect(wrapper.get('.q-ssheet__top').classes()).toEqual(['q-ssheet__top']);
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

describe('SolutionSheet figure-only entries', () => {
  const figureOnly = [{ result: [{ t: 'text' as const, v: '' }], figures: [] }];

  it('drops the result card when the entry has no text', () => {
    // The answer is the figure; a card around nothing is an empty framed box
    // sitting under „Offizieller Lösungsweg".
    const wrapper = mountSheet({ detent: 'default', solution: figureOnly });
    expect(wrapper.find('.q-ssheet__card').exists()).toBe(false);
    // The heading still stands — the entry exists, it just has no prose.
    expect(wrapper.get('.q-ssheet__title').text()).toBe('Offizieller Lösungsweg');
  });

  it('still renders the card when there is something to say', () => {
    const wrapper = mountSheet({
      detent: 'default',
      solution: [{ result: [{ t: 'text' as const, v: 'x = 3' }], figures: [] }],
    });
    expect(wrapper.get('.q-ssheet__card').text()).toContain('x = 3');
  });
})
