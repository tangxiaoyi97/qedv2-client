import { describe, expect, it } from 'vitest';
import barSource from '../../ui/src/practice/PracticeBottomBar.vue?raw';
import sheetSource from '../../ui/src/practice/SolutionSheet.vue?raw';

/**
 * The full-screen detent is computed in JS (viewport − top bar − measured
 * chrome). That arithmetic was wrong twice, and each time the fixed bottom
 * stack rode over the practice top bar and hid the progress segments — with
 * every unit test green, because none of them lay anything out.
 *
 * So the guarantee is CSS, not arithmetic: the bar cannot be taller than the
 * space below the top bar, whatever the maths decides. These assertions pin
 * the three declarations that make that true.
 */
const barStyle = /<style scoped>([\s\S]*)<\/style>/.exec(barSource)?.[1] ?? '';
const sheetStyle = /<style scoped>([\s\S]*)<\/style>/.exec(sheetSource)?.[1] ?? '';
const rule = (css: string, selector: string): string =>
  new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';

describe('practice bar ceiling', () => {
  it('caps the bar at the space the top bar leaves', () => {
    const bar = rule(barStyle, '.practice-bar');
    expect(bar).toMatch(/max-height:\s*calc\(/);
    // Uses the height the shell measures, and falls back to the CSS the top
    // bar is actually written with (56px + the notch) rather than a guess.
    expect(bar).toContain('--practice-topbar-height');
    expect(bar).toContain('env(safe-area-inset-top)');
  });

  it('makes the sheet the part that yields, never the action row', () => {
    // Without this the bar would simply overflow its own max-height.
    expect(rule(barStyle, '.practice-bar')).toContain('flex-direction: column');
    expect(rule(barStyle, '.practice-bar__sheet')).toMatch(/min-height:\s*0/);
    expect(rule(barStyle, '.practice-bar__sheet')).toMatch(/flex:\s*0 1 auto/);
    expect(rule(barStyle, '.practice-bar__row')).toMatch(/flex:\s*none/);
  });

  it('lets the squeeze reach through the sheet wrapper', () => {
    // The wrapper sits between the bar and the scrolling section; a default
    // `min-height: auto` there would block the shrink.
    expect(rule(sheetStyle, '.q-ssheet-wrap')).toMatch(/min-height:\s*0/);
    expect(rule(sheetStyle, '.q-ssheet')).toMatch(/min-height:\s*0/);
    expect(rule(sheetStyle, '.q-ssheet')).toMatch(/flex:\s*0 1 auto/);
  });
});

/**
 * Layout the unit tests cannot see, pinned as declarations. Both of these
 * were shipped broken and only showed up in a screenshot.
 */
describe('practice bar chrome', () => {
  it('meets the top bar without stacking hairlines at full screen', () => {
    // The top bar draws its own border-bottom. Ours on top of it, plus the
    // upward shadow smudging the pixels above, read as a gap between two
    // surfaces that are in fact flush.
    const full = rule(barStyle, '.practice-bar--full');
    expect(full).toMatch(/border-top-width:\s*0/);
    expect(full).toMatch(/box-shadow:\s*none/);
  });

  it('stretches the action row across the bar', () => {
    // The bar is a column flex container and the row has auto inline margins.
    // An auto inline margin cancels `align-items: stretch`, so without an
    // explicit width the row collapses to fit-content and the buttons end up
    // floating in the middle of the bar.
    const row = rule(barStyle, '.practice-bar__row');
    expect(row).toMatch(/width:\s*100%/);
    expect(row).toMatch(/margin:\s*0 auto/);
  });

  it('separates the shut grip from the action row', () => {
    expect(rule(sheetStyle, '.q-ssheet__top--closed')).toMatch(
      /border-bottom-color:\s*var\(--q-border\)/,
    );
  });
});
