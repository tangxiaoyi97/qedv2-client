import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import type { LeaderboardDetail, LeaderboardItem } from '@qed2/core-logic';
import LeaderboardRow from '../src/leaderboard/LeaderboardRow.vue';
import LeaderboardDetailDrawer from '../src/leaderboard/LeaderboardDetailDrawer.vue';
import { setUiLocale } from '../src/i18n.js';

const item: LeaderboardItem = {
  profileId: 'profile-1', nickname: 'Ada', isMe: false, rank: 1,
  todayPracticed: 7, weekPracticed: 21, totalPracticed: 144, totalScore: 255,
};
const detail: LeaderboardDetail = {
  ...item, joinedAt: '2026-09-01T00:00:00.000Z',
  todayScore: 9, weekScore: 28, correctAnswers: 204, accuracy: 80,
};
const wrappers: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  setUiLocale('de');
});

describe('LeaderboardRow', () => {
  it.each([1, 2, 3, 4, 57])('shows the actual rank %s, including the podium', (rank) => {
    const wrapper = track(mount(LeaderboardRow, { props: { item: { ...item, rank }, period: 'today' } }));
    expect(wrapper.get('.leader-row__rank').text()).toBe(String(rank));
    expect(wrapper.attributes('aria-label')).toContain(`Rang ${rank}`);
  });

  it('preserves all three metrics without repeating column labels in every row', async () => {
    const wrapper = track(mount(LeaderboardRow, { props: { item, period: 'today' } }));
    expect(wrapper.findAll('.leader-row__stat strong').map((stat) => stat.text())).toEqual(['7', '144', '255']);
    expect(wrapper.find('.leader-row__mobile-label').exists()).toBe(false);
    expect(wrapper.attributes('aria-label')).toContain('Heute: 7, Gesamt: 144, Punkte: 255');
    await wrapper.setProps({ period: 'week' });
    expect(wrapper.findAll('.leader-row__stat strong').map((stat) => stat.text())).toEqual(['21', '144', '255']);
    expect(wrapper.attributes('aria-label')).toContain('Diese Woche: 21');
  });

  it('uses a native button, opens the exact profile, and identifies the current user without color alone', async () => {
    const wrapper = track(mount(LeaderboardRow, { props: { item: { ...item, isMe: true }, period: 'today' } }));
    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.attributes('type')).toBe('button');
    expect(wrapper.get('.leader-row__you').text()).toBe('Du');
    expect(wrapper.attributes('aria-label')).toContain(', Du');
    await wrapper.trigger('click');
    expect(wrapper.emitted('open')).toEqual([['profile-1']]);
  });

  it('keeps full names and large exact counts available when visual columns truncate', () => {
    setUiLocale('en');
    const longName = 'a sufficiently long nickname';
    const wrapper = track(mount(LeaderboardRow, {
      props: { item: { ...item, nickname: longName, totalPracticed: 1234567, totalScore: 7654321 }, period: 'today' },
    }));
    expect(wrapper.get('.leader-row__nickname').attributes('title')).toBe(longName);
    expect(wrapper.findAll('.leader-row__stat strong')[1]!.attributes('title')).toBe('1,234,567');
    expect(wrapper.attributes('aria-label')).toContain('Total: 1,234,567, Points: 7,654,321');
    expect(wrapper.attributes('aria-label')).toContain('rank 1');
  });
});

describe('LeaderboardDetailDrawer', () => {
  const base = { open: true, detail: undefined, loading: false, error: '' };
  const global = { stubs: { teleport: true, transition: false } };

  it('retains every original calculation and clearly groups the public metrics', () => {
    const wrapper = track(mount(LeaderboardDetailDrawer, { props: { ...base, detail }, global }));
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Details zu Ada');
    expect(wrapper.findAll('.leader-detail__summary strong').map((value) => value.text())).toEqual(['144', '255']);
    expect(wrapper.findAll('.leader-detail__periods strong').map((value) => value.text())).toEqual(['7', '21']);
    expect(wrapper.findAll('.leader-detail__periods small').map((value) => value.text())).toEqual(['9 Punkte', '28 Punkte']);
    expect(wrapper.get('.leader-detail__accuracy').text()).toContain('204 von 255');
    expect(wrapper.get('.leader-detail__accuracy b').text()).toBe('80 %');
    expect(wrapper.get('.q-icon-btn').attributes('aria-label')).toBe('Schließen');
  });

  it('announces loading once, offers retry for an error, and exposes the close action throughout', async () => {
    const wrapper = track(mount(LeaderboardDetailDrawer, { props: { ...base, loading: true }, global }));
    expect(wrapper.get('[role="dialog"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.findAll('[role="status"]')).toHaveLength(1);
    await wrapper.setProps({ loading: false, error: 'Die Details konnten nicht geladen werden.' });
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Leaderboard');
    expect(wrapper.get('[role="alert"]').text()).toContain('Die Details konnten nicht geladen werden.');
    await wrapper.get('.leader-detail__error .q-btn').trigger('click');
    expect(wrapper.emitted('retry')).toEqual([[]]);
    await wrapper.get('.q-icon-btn').trigger('click');
    expect(wrapper.emitted('close')).toEqual([[]]);
  });

  it('preserves the no-attempt accuracy state without inventing zero percent', () => {
    const wrapper = track(mount(LeaderboardDetailDrawer, {
      props: { ...base, detail: { ...detail, correctAnswers: 0, totalScore: 0, accuracy: null } }, global,
    }));
    expect(wrapper.get('.leader-detail__accuracy b').text()).toBe('—');
  });
});
