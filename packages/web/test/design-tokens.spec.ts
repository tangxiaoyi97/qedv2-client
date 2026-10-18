/**
 * Design-token discipline. The UI used to carry 28 literal font sizes and
 * 18 literal corner radii, several half a pixel apart for the same job; the
 * shared scale in @qed2/ui/layout-tokens replaced them. These checks keep a
 * new component from quietly re-introducing a one-off value.
 */
import { describe, expect, it } from 'vitest';
import layoutTokens from '../../ui/src/styles/layout-tokens.css?raw';
import tokensCss from '../../ui/src/styles/tokens.css?raw';
import appCss from '../src/styles/app.css?raw';

const sources: Record<string, string> = {
  ...import.meta.glob(['../src/**/*.vue', '../src/**/*.css', '!../src/admin/**'], {
    query: '?raw', import: 'default', eager: true,
  }),
  ...import.meta.glob(['../../ui/src/**/*.vue'], { query: '?raw', import: 'default', eager: true }),
};

/** Only the <style> blocks of a component; templates may legitimately say "12px". */
function styles(source: string): string {
  const blocks = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return blocks.length > 0 ? blocks.join('\n') : source;
}

describe('design tokens', () => {
  it('defines one named scale for type, radius, stacking and fixed chrome', () => {
    for (const token of [
      '--q-font-family', '--q-font-mono', '--q-font-2xs', '--q-font-xs', '--q-font-small',
      '--q-font-meta', '--q-font-ui', '--q-font-md', '--q-font-lg', '--q-font-xl',
      '--q-font-title', '--q-font-headline', '--q-font-display', '--q-font-hero',
      '--q-eyebrow-size', '--q-eyebrow-weight', '--q-eyebrow-tracking',
      '--q-radius-xs', '--q-radius-sm', '--q-radius-control', '--q-radius-card',
      '--q-radius-dialog', '--q-radius-pill', '--q-touch-target', '--q-topbar-height',
      '--q-tabbar-height', '--q-z-sticky', '--q-z-bar', '--q-z-toast', '--q-z-modal',
      '--q-transition-layout',
    ]) {
      expect(layoutTokens, token).toMatch(new RegExp(`${token}:`));
    }
  });

  it('raises text controls to a 48px target on touch screens only', () => {
    expect(layoutTokens).toContain('--q-control-height: 44px');
    expect(layoutTokens).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--q-control-height: 48px;/);
  });

  it('keeps body text sizes and corner radii on the shared scale', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const css = styles(source);
      for (const match of css.matchAll(/font-size:\s*(1[0-5](?:\.\d+)?)px/g)) {
        offenders.push(`${path}: font-size ${match[1]}px`);
      }
      for (const match of css.matchAll(/\bfont:\s*\d{3}\s+(1[0-5](?:\.\d+)?)px/g)) {
        offenders.push(`${path}: font ${match[1]}px`);
      }
      for (const match of css.matchAll(/border-radius:\s*(\d+)px\s*[;}]/g)) {
        const px = Number(match[1]);
        // 1–3px are hairline marks (grips, meter ends), not corners.
        if (px > 3) offenders.push(`${path}: border-radius ${px}px`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shares one eyebrow role and screen-reader utility', () => {
    const eyebrow = /\.q-eyebrow\s*\{[^}]*\}/.exec(tokensCss)?.[0] ?? '';
    expect(eyebrow).toContain('font-size: var(--q-eyebrow-size)');
    expect(eyebrow).toContain('letter-spacing: var(--q-eyebrow-tracking)');
    expect(tokensCss).toMatch(/\.q-visually-hidden\s*\{/);
    for (const path of [
      '../../ui/src/practice/PracticeSessionRail.vue',
      '../../ui/src/practice/PracticeSessionDrawer.vue',
      '../../ui/src/practice/SolutionSheet.vue',
      '../src/App.vue',
    ]) {
      expect(sources[path], path).toContain('letter-spacing: var(--q-eyebrow-tracking)');
    }
  });

  it('keeps focused fields clear of fixed bars through root scroll padding', () => {
    expect(appCss).toMatch(/scroll-padding-bottom:\s*calc\(var\(--q-scroll-pad-bottom, 0px\) \+ var\(--q-keyboard-inset, 0px\)\)/);
    expect(appCss).toContain('--q-scroll-pad-bottom: calc(var(--q-tabbar-height) + env(safe-area-inset-bottom) + 12px)');
  });

  it('suppresses the iOS long-press callout on chrome, never on content', () => {
    expect(tokensCss).toMatch(/@media \(pointer: coarse\)\s*\{\s*:where\(\.q-app, #app\) :is\(button,[^{]*\{[^}]*-webkit-touch-callout: none/);
  });
});
