import { createApp } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELECTABLE_GRADINGS } from '@qed2/core-logic';
import type { PartPlayerState } from '../src/index.js';
import PracticeBottomBar from '../src/practice/PracticeBottomBar.vue';

const reviewed = (verdict: 'correct' | 'partial' | 'incorrect'): PartPlayerState => ({
  phase: 'reviewed',
  canSubmit: false,
  result: {
    verdict,
    correct: verdict === 'correct',
    awardedPoints: verdict === 'correct' ? 1 : 0,
    maxPoints: 1,
  },
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  submittedText: '',
  selfAssessment: null,
});

const answering: PartPlayerState = {
  phase: 'answering',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  submittedText: '',
  selfAssessment: null,
};

const selfAssessing: PartPlayerState = {
  phase: 'self-assessing',
  canSubmit: false,
  result: null,
  indeterminate: false,
  unplayable: false,
  answerPreview: null,
  submittedText: '',
  selfAssessment: {
    maxPoints: 1,
    scoreOptions: [
      { points: 0, label: '0' },
      { points: 1, label: '1' },
    ],
    selectedPoints: null,
    grading: null,
    assessment: {},
  },
};

function mountBar(state: PartPlayerState, extra: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(PracticeBottomBar, {
    state,
    answerPreview: null,
  submittedText: '',
    solutionDetent: 'collapsed',
    grading: 'unseen',
    primaryLabel: 'Weiter →',
    primaryDisabled: false,
    solution: [],
    ...extra,
  });
  app.mount(host);
  return { host, unmount: () => app.unmount() };
}

describe('PracticeBottomBar', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('puts self-assessment inside the sheet, under the solution it judges', () => {
    // It used to sit in the scrolling question body (rubric parts) or be
    // crammed into the action row (everything else), either way separated
    // from the solution the user is supposed to compare against.
    const { host, unmount } = mountBar(selfAssessing, {
      solutionDetent: 'full',
      primaryLabel: 'Bewertung übernehmen',
      primaryDisabled: true,
    });

    const panel = host.querySelector('.q-selfassess');
    expect(panel).not.toBeNull();
    expect(host.querySelector('.q-ssheet__assessment')?.contains(panel!)).toBe(true);
    expect(host.querySelector('.practice-bar__row')?.contains(panel!)).toBe(false);
    unmount();
  });

  it('picks the mastery state with icon buttons, not a dropdown', () => {
    const { host, unmount } = mountBar(selfAssessing, {
      solutionDetent: 'full',
      primaryLabel: 'Bewertung übernehmen',
      primaryDisabled: true,
    });

    // A native select hid the choice behind a tap and spoke in plain text
    // while every other grading surface speaks in dots.
    expect(host.querySelector('select')).toBeNull();
    const options = host.querySelectorAll('.q-gpick__opt');
    expect(options).toHaveLength(SELECTABLE_GRADINGS.length);
    for (const option of options) expect(option.querySelector('.q-grading-dot')).not.toBeNull();
    expect(host.textContent).toContain('Bewertung');
    unmount();
  });

  it('keeps the running score in the bar, where the sheet cannot hide it', () => {
    const { host, unmount } = mountBar(selfAssessing, { solutionDetent: 'collapsed' });
    expect(host.querySelector('.practice-bar__preview-value')?.textContent).toBe('– / 1');
    expect(host.querySelector('.practice-bar__visually-hidden')?.textContent?.trim()).toBe('Deine Punkte:');
    expect(host.querySelector('.practice-bar__preview-main')?.getAttribute('aria-label')).toBeNull();
    unmount();
  });

  it('says nothing at all while the question is untouched', () => {
    // The bar used to nag „Antwort oben auswählen …" into the empty slot.
    // An empty slot is the correct amount of instruction.
    const { host, unmount } = mountBar(answering);
    expect(host.textContent).not.toContain('Antwort oben');
    expect(host.querySelector('.practice-bar__hint')).toBeNull();
    unmount();
  });

  it('keeps the verdict out of the action row and inside the sheet', () => {
    const { host, unmount } = mountBar(reviewed('incorrect'), { solutionDetent: 'default' });
    expect(host.querySelector('.practice-bar__row')?.textContent).not.toContain('Falsch');
    const verdict = host.querySelector('.q-ssheet__verdict');
    expect(verdict?.textContent).toContain('Falsch');
    expect(verdict?.textContent).toContain('0 / 1 P');
    unmount();
  });

  it('never colours the bar or the drawer by the result', () => {
    for (const verdict of ['correct', 'partial', 'incorrect'] as const) {
      const { host, unmount } = mountBar(reviewed(verdict), { solutionDetent: 'default' });
      expect(host.querySelector('.practice-bar__tint'), verdict).toBeNull();
      // Layout classes from the parent are fine; what must not appear is a
      // verdict modifier — colour-coding the drawer was removed.
      const wrapClasses = host.querySelector('.q-ssheet-wrap')?.className ?? '';
      expect(wrapClasses, verdict).not.toMatch(/q-ssheet-wrap--/);
      unmount();
      document.body.innerHTML = '';
    }
  });

  it('shows the grab handle only once there is something to reveal', () => {
    const before = mountBar(answering);
    expect(before.host.querySelector('.q-ssheet__handle')).toBeNull();
    before.unmount();
    document.body.innerHTML = '';

    const after = mountBar(reviewed('correct'));
    expect(after.host.querySelector('.q-ssheet__handle')).not.toBeNull();
    after.unmount();
  });

  it('locks manual grading while the parent is committing the answer', () => {
    const { host, unmount } = mountBar(reviewed('incorrect'), {
      gradingDisabled: true,
    });
    const trigger = host.querySelector<HTMLButtonElement>('.q-grading-menu button');
    expect(trigger?.disabled).toBe(true);
    trigger?.click();
    expect(host.querySelector('.q-grading-menu__popover')).toBeNull();
    unmount();
  });

  it('keeps one help entry after an incorrect answer, with no correction control', () => {
    let toggles = 0;
    const { host, unmount } = mountBar(reviewed('incorrect'), {
      learningAvailable: true,
      onLearningToggle: () => { toggles += 1; },
    });
    const help = host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle');
    expect(help?.textContent?.trim()).toBe('Lernhilfe');
    expect(help?.getAttribute('aria-label')).toBe('Lernhilfe öffnen');
    expect(help?.getAttribute('aria-expanded')).toBe('false');
    help?.click();
    expect(toggles).toBe(1);
    expect(host.textContent).not.toContain('Korrektur');
    unmount();
  });

  it('keeps the phase action in layout while saving, with an accessible busy state', async () => {
    vi.useFakeTimers();
    const wrapper = mount(PracticeBottomBar, {
      props: {
        state: selfAssessing, answerPreview: null, solutionDetent: 'full', grading: 'unseen',
        primaryLabel: 'Bewertung übernehmen', primaryDisabled: false,
      },
    });
    const button = wrapper.get('.practice-bar__right > .q-btn');
    const content = button.get('.q-btn__content').element;
    await wrapper.setProps({ primaryBusy: true, primaryDisabled: true });
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.attributes('aria-label')).toBe('Speichert …');
    expect(button.get('.q-btn__content').element).toBe(content);
    expect(button.get('.q-btn__content').text()).toBe('Bewertung übernehmen');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.find('.q-btn__spinner').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(119);
    expect(button.find('.q-btn__spinner').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(button.find('.q-btn__spinner').exists()).toBe(true);

    // Entering review also adds a grading menu. The new phase's shorter
    // action must take over immediately, even while the commit is finishing,
    // so an obsolete long action cannot force an extra row in between.
    await wrapper.setProps({ state: reviewed('correct'), primaryLabel: 'Weiter' });
    expect(wrapper.find('.practice-bar__grading').exists()).toBe(true);
    expect(button.get('.q-btn__content').text()).toBe('Weiter');
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.attributes('aria-label')).toBe('Speichert …');
    await wrapper.setProps({ primaryBusy: false, primaryDisabled: false });
    expect(button.get('.q-btn__content').text()).toBe('Weiter');
    expect(button.find('.q-btn__spinner').exists()).toBe(false);
    expect(button.attributes('aria-label')).toBeUndefined();
    wrapper.unmount();
  });

  it('does not flash a spinner for a fast draft save or leave a delayed spinner behind', async () => {
    vi.useFakeTimers();
    const wrapper = mount(PracticeBottomBar, {
      props: {
        state: answering, answerPreview: null, solutionDetent: 'collapsed', grading: 'unseen',
        primaryLabel: 'Prüfen', primaryDisabled: false,
      },
    });
    const button = wrapper.get('.practice-bar__primary');
    await wrapper.setProps({ primaryBusy: true });
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.get('.q-btn__content').text()).toBe('Prüfen');
    await vi.advanceTimersByTimeAsync(30);
    await wrapper.setProps({ primaryBusy: false });
    await vi.advanceTimersByTimeAsync(150);
    expect(button.find('.q-btn__spinner').exists()).toBe(false);
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.attributes('aria-busy')).toBeUndefined();
    wrapper.unmount();
  });
});
