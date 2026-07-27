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

const named = (path: string): string => path.split('/').slice(-1)[0]!;

describe('loading states', () => {
  it('defines the shimmer once, in the shared stylesheet', () => {
    expect(tokensCss).toContain('q-skeleton-sweep');
  });

  it('leaves no per-view pulse animation behind, bar the practice loader', () => {
    const offenders = Object.entries(viewSources)
      .filter(([, source]) => /@keyframes\s+pulse\b/.test(source))
      .map(([path]) => named(path));
    // PracticeView keeps its bespoke loader: it is the one screen where the
    // wait is part of the experience, and the user asked for it untouched.
    expect(offenders).toEqual(['PracticeView.vue']);
  });

  it('routes every remaining waiting state through the shared components', () => {
    const waiting = ['BrowseView.vue', 'HistoryView.vue', 'LeaderboardView.vue'];
    for (const view of waiting) {
      const source = Object.entries(viewSources).find(([path]) => named(path) === view)?.[1] ?? '';
      expect(source, view).toMatch(/<QSkeleton|<QLoadingPanel/);
    }
  });
});
