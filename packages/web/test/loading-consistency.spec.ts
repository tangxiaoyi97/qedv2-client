/**
 * Every view waits the same way. Before this, BrowseView, HistoryView and
 * PracticeView each declared their own `@keyframes pulse` and their own
 * skeleton rule, so three screens shimmered at three slightly different
 * rhythms; LeaderboardView just printed a line of text.
 */
import { describe, expect, it } from 'vitest';
import tokensCss from '../../ui/src/styles/tokens.css?inline';

const viewSources = import.meta.glob('../src/routes/**/*.vue', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const allSources = { ...viewSources, ...(import.meta.glob('../src/App.vue', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>) };

const named = (path: string): string => path.split('/').slice(-1)[0]!;

describe('loading states', () => {
  it('defines the shimmer once, in the shared stylesheet', () => {
    expect(tokensCss).toContain('q-skeleton-sweep');
  });

  it('pins the cross-fade column to the container width', () => {
    // Regression: with the implicit `auto` column the track is sized to
    // max-content, so every view's `max-width` turned into a demand rather
    // than a cap and Übersicht/Verlauf overflowed the viewport on a phone.
    const rule = /\.q-crossfade\s*\{[^}]*\}/.exec(tokensCss)?.[0] ?? '';
    expect(rule).toContain('display: grid');
    expect(rule).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('leaves no per-view pulse animation behind, bar the practice loader', () => {
    const offenders = Object.entries(viewSources)
      .filter(([, source]) => /@keyframes\s+pulse\b/.test(source))
      .map(([path]) => named(path));
    // PracticeView keeps its bespoke loader: it is the one screen where the
    // wait is part of the experience, and the user asked for it untouched.
    expect(offenders).toEqual(['PracticeView.vue']);
  });

  it('never swaps states with a mode that empties the container first', () => {
    // `mode="out-in"` waits for the old state to finish leaving before the new
    // one starts — the gap in between is the flicker. Every swap cross-fades.
    const blanking = Object.entries(allSources)
      .filter(([, source]) => /mode="out-in"/.test(source))
      .map(([path]) => named(path));
    expect(blanking).toEqual([]);
  });

  it('stacks the children of every cross-fade so the swap cannot shift layout', () => {
    // A <transition name="q-crossfade"> is only safe on a `.q-crossfade`
    // container: without the grid stacking the two states would sit one under
    // the other mid-swap.
    for (const [path, source] of Object.entries(allSources)) {
      const transitions = (source.match(/<transition name="q-crossfade"/g) ?? []).length;
      if (transitions === 0) continue;
      const containers = (source.match(/class="[^"]*\bq-crossfade\b[^"]*"/g) ?? []).length;
      expect(containers, named(path)).toBeGreaterThanOrEqual(transitions);
    }
  });

  it('routes every remaining waiting state through the shared components', () => {
    const waiting = ['BrowseView.vue', 'HistoryView.vue', 'LeaderboardView.vue'];
    for (const view of waiting) {
      const source = Object.entries(viewSources).find(([path]) => named(path) === view)?.[1] ?? '';
      expect(source, view).toMatch(/<QSkeleton|<QLoadingPanel/);
    }
  });
});
