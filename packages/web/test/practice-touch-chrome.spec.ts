/**
 * Practice chrome on phones and touch screens. Media queries and fixed
 * positioning cannot be evaluated by jsdom, so the layout contracts are read
 * from the stylesheets the same way practice-bar-ceiling.spec.ts does.
 */
import { describe, expect, it } from 'vitest';
import practiceSource from '../src/routes/PracticeView.vue?raw';
import barSource from '../../ui/src/practice/PracticeBottomBar.vue?raw';
import buttonSource from '../../ui/src/shared/QButton.vue?raw';

const style = (source: string) => /<style scoped>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? '';
const barStyle = style(barSource);
const practiceStyle = style(practiceSource);

/** The LAST block for a query: page-based review overrides come after the base rules. */
function mediaBlock(css: string, query: string): string {
  const start = css.lastIndexOf(`@media ${query} {`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

describe('practice action bar on phones', () => {
  it('lets the primary action take the remaining width instead of floating left', () => {
    const phone = mediaBlock(barStyle, '(max-width: 640px)');
    expect(phone).toMatch(/\.practice-bar__primary\s*\{\s*flex:\s*1 1 auto;/);
    expect(phone).toMatch(/\.practice-bar__left:empty\s*\{\s*display:\s*none;/);
    const narrow = mediaBlock(barStyle, '(max-width: 380px)');
    // The grading override must stay reachable on 360–380px phones.
    expect(narrow).not.toMatch(/\.practice-bar__left\s*\{\s*display:\s*none/);
    expect(narrow).not.toContain('justify-content: space-between');
  });

  it('gives the secondary controls one shared geometry', () => {
    const family = /\.practice-bar__grading :deep\(\.q-grading-capsule\),\s*\.practice-bar__solution-toggle,\s*\.practice-bar__learning-toggle\s*\{[^}]*\}/
      .exec(barStyle)?.[0] ?? '';
    expect(family).toContain('min-height: var(--q-control-height)');
    expect(family).toContain('border-radius: var(--q-radius-control)');
    expect(family).toContain('text-transform: none');
  });
});

describe('practice notices', () => {
  it('stacks every notice in one container above the measured bar', () => {
    const template = practiceSource.slice(practiceSource.indexOf('<template>'));
    const stack = template.slice(template.indexOf('class="practice__notices"'));
    const stackEnd = stack.indexOf('</transition>');
    for (const notice of ['practice.warning', 'commitError ||', "progress.syncStatus.state === 'offline'"]) {
      expect(stack.indexOf(notice), notice).toBeGreaterThan(-1);
      expect(stack.indexOf(notice), notice).toBeLessThan(stackEnd);
    }
    const rule = /\.practice__notices\s*\{[^}]*\}/.exec(practiceStyle)?.[0] ?? '';
    expect(rule).toContain('var(--practice-bar-height');
    expect(rule).toContain('var(--q-keyboard-inset, 0px)');
    expect(practiceStyle).not.toMatch(/bottom:\s*calc\(76px/);
  });

  it('publishes the live bar height for notices and focus scrolling, and cleans up', () => {
    expect(practiceSource).toContain(':ref="setBarRef"');
    expect(practiceSource).toContain("root.setProperty('--q-scroll-pad-bottom'");
    expect(practiceSource).toContain("document.documentElement.style.removeProperty('--q-scroll-pad-bottom')");
  });

  it('offers a compact button size that keeps a full touch target', () => {
    expect(buttonSource).toContain("size?: 'md' | 'sm'");
    expect(buttonSource).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.q-btn\.q-btn--sm\s*\{\s*min-height:\s*var\(--q-touch-target\)/);
  });
});
