import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { h, nextTick } from 'vue';
import type { PartPlayerState } from '../src/index.js';
import PracticeBottomBar from '../src/practice/PracticeBottomBar.vue';
import PracticeReviewPanel from '../src/practice/PracticeReviewPanel.vue';
import SolutionSheet from '../src/practice/SolutionSheet.vue';

const assessing: PartPlayerState = {
  phase: 'self-assessing', canSubmit: false, result: null,
  indeterminate: false, unplayable: false, answerPreview: null,
  submittedText: 'Meine eigene Antwort',
  selfAssessment: {
    maxPoints: 1, scoreOptions: [{ points: 0, label: '0' }, { points: 1, label: '1' }],
    selectedPoints: null, grading: null, assessment: {},
  },
};
const solution = [{ result: [{ t: 'text' as const, v: 'Die offizielle Lösung' }], note: 'Ein Punkt für die richtige Begründung.' }];
const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountReviewBar(extra: Record<string, unknown> = {}) {
  const state = (extra.state as PartPlayerState | undefined) ?? assessing;
  const view = mount(PracticeBottomBar, {
    props: {
      state: assessing, answerPreview: null, grading: 'unseen',
      primaryLabel: 'Bewertung übernehmen', primaryDisabled: true,
      solutionDetent: 'full', solutionReady: true, learningDialog: true,
      solution: [{ result: [{ t: 'text', v: 'Duplicate legacy solution' }] }],
      ...extra,
    },
    slots: {
      review: () => h(PracticeReviewPanel, { state, solution, ready: true, hideResult: true }),
      assist: '<p>Duplicate legacy assessment</p>',
      explain: '<p>Legacy AI content</p>',
    },
    attachTo: document.body,
  });
  mounted.push(view);
  return view;
}

describe('practice review drawer', () => {
  it('keeps notes and assessment mounted below the preview and resets the scroll when returning to it', async () => {
    const view = mountReviewBar({ solutionDetent: 'default' });
    const sheet = view.get<HTMLElement>('.q-ssheet');
    expect(sheet.text()).toContain('Die offizielle Lösung');
    const note = sheet.get('.q-solution__note').element;
    const assessment = sheet.get('.q-selfassess').element;
    expect(sheet.text()).toContain('Beurteilungshinweis');
    await view.setProps({ solutionDetent: 'full' });
    expect(sheet.text()).toContain('Ein Punkt für die richtige Begründung.');
    expect(sheet.find('.q-selfassess').exists()).toBe(true);
    sheet.element.scrollTop = 250;
    await view.setProps({ solutionDetent: 'default' });
    await nextTick();
    expect(sheet.element.scrollTop).toBe(0);
    expect(sheet.text()).toContain('Die offizielle Lösung');
    expect(sheet.get('.q-solution__note').element).toBe(note);
    expect(sheet.get('.q-selfassess').element).toBe(assessment);
    expect(sheet.get('.q-solution__note').isVisible()).toBe(true);
  });

  it('keeps all default-template content available to scroll at every open detent', async () => {
    const view = mount(SolutionSheet, {
      props: { solution, detent: 'default', handle: true },
      slots: { assessment: '<button>Grade answer</button>', explain: '<p>Extra explanation</p>' },
      attachTo: document.body,
    });
    mounted.push(view);
    expect(view.text()).toContain('Die offizielle Lösung');
    expect(view.get('.q-ssheet__note').text()).toContain('Beurteilungshinweis');
    expect(view.text()).toContain('Grade answer');
    expect(view.text()).toContain('Extra explanation');
    await view.setProps({ detent: 'full' });
    expect(view.get('.q-ssheet__note').text()).toContain('Beurteilungshinweis');
    expect(view.text()).toContain('Grade answer');
    expect(view.text()).toContain('Extra explanation');
    await view.setProps({ detent: 'default' });
    expect(view.find('.q-ssheet__note').exists()).toBe(true);
    expect(view.find('.q-ssheet__assessment').exists()).toBe(true);
  });

  it('measures the marked official answer, never the taller notes and grading controls', async () => {
    let answerHeight = 120;
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-solution-detail') ? 200 + answerHeight + 6 : 200;
      const height = this.hasAttribute('data-solution-preview') ? answerHeight
        : this.classList.contains('q-ssheet__review') ? 1600 : 0;
      return { x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height, toJSON: () => ({}) };
    });
    const view = mountReviewBar({ solutionDetent: 'default' });
    await nextTick(); await nextTick();
    const height = () => parseFloat(view.get<HTMLElement>('.q-ssheet').element.style.height);
    expect(height()).toBe(120);
    expect(view.find('.q-solution__note').exists()).toBe(true);
    expect(view.find('.q-selfassess').exists()).toBe(true);
    answerHeight = 350; // Wrapping text or a late-loading solution figure.
    resize();
    await nextTick();
    expect(height()).toBe(350);
    await view.setProps({ solutionDetent: 'full' });
    expect(height()).toBeGreaterThan(350);
    await view.setProps({ solutionDetent: 'default' });
    await nextTick();
    expect(height()).toBe(350);
    answerHeight = 1600;
    resize();
    await nextTick();
    expect(height()).toBeLessThanOrEqual(460);
  });

  it('places the simplified solution and manual grading inside the drawer exactly once', () => {
    const view = mountReviewBar();
    const sheet = view.get('.q-ssheet');
    expect(sheet.text()).not.toContain('Meine eigene Antwort');
    expect(sheet.get('.practice-review__solution').text()).toContain('Die offizielle Lösung');
    expect(sheet.findAll('.q-selfassess')).toHaveLength(1);
    expect(sheet.findAll('.q-gpick')).toHaveLength(1);
    expect(sheet.text()).not.toContain('Duplicate legacy');
    expect(sheet.text()).not.toContain('Legacy AI content');
    expect(view.find('.practice-bar__row .q-selfassess').exists()).toBe(false);
  });

  it('keeps one result in the same header row at every drawer height', async () => {
    const state: PartPlayerState = {
      ...assessing, phase: 'reviewed', selfAssessment: null,
      result: { verdict: 'correct', correct: true, awardedPoints: 1, maxPoints: 1 },
    };
    const view = mountReviewBar({ state });
    const header = view.get('.q-ssheet__handle-result').element;
    for (const solutionDetent of ['full', 'default', 'collapsed'] as const) {
      await view.setProps({ solutionDetent });
      expect(view.get('.q-ssheet__handle-result').element).toBe(header);
      expect(view.get('.q-ssheet__handle-result').text()).toContain('Richtig');
      expect(view.findAll('.q-ssheet__verdict-label')).toHaveLength(1);
      expect(view.get('.q-ssheet__handle').attributes('aria-label')).toContain('1 / 1');
      expect(view.find('.q-ssheet__banner').exists()).toBe(false);
    }
    expect(view.find('.practice-review__result').exists()).toBe(false);
    expect(view.find('.q-selfassess').exists()).toBe(false);
  });

  it('does not invoke custom solution content before a durable first submission', async () => {
    const view = mountReviewBar({ solutionReady: false });
    expect(view.find('.practice-review').exists()).toBe(false);
    expect(view.text()).not.toContain('Die offizielle Lösung');
    expect(view.text()).not.toContain('Duplicate legacy solution');
    expect(view.get('.q-ssheet').text()).toContain('Antwort wird gesichert …');
    await view.setProps({ solutionReady: true });
    expect(view.get('.q-ssheet').text()).toContain('Die offizielle Lösung');
    await view.setProps({ state: { ...assessing, phase: 'answering', selfAssessment: null } });
    expect(view.find('.practice-review').exists()).toBe(false);
    expect(view.find('.q-ssheet__handle').exists()).toBe(false);
  });

  it('keeps a labelled reopening control while collapsed and removes the sheet from focus', async () => {
    const view = mountReviewBar({ solutionDetent: 'collapsed' });
    const handle = view.get('.q-ssheet__handle');
    const sheet = view.get('.q-ssheet');
    expect(handle.text()).toContain('Lösung & Bewertung');
    expect(handle.attributes('aria-label')).toBe('Lösung & Bewertung anzeigen');
    expect(handle.attributes('aria-controls')).toBe(sheet.attributes('id'));
    expect(sheet.attributes('inert')).toBeDefined();
    expect(sheet.attributes('aria-hidden')).toBe('true');
    expect(sheet.attributes('tabindex')).toBe('-1');
    expect(sheet.attributes('style')).toContain('height: 0px');
    await handle.trigger('click');
    expect(view.emitted('update:solutionDetent')?.at(-1)).toEqual(['default']);
    await view.setProps({ solutionDetent: 'default' });
    expect(sheet.attributes('inert')).toBeUndefined();
    expect(sheet.attributes('aria-hidden')).toBe('false');
  });

  it('keeps the existing swipe, keyboard, and Escape return-focus behavior for custom review', async () => {
    const view = mountReviewBar({ solutionDetent: 'default' });
    const handle = view.get('.q-ssheet__handle');
    await handle.trigger('pointerdown', { clientY: 500, pointerId: 1 });
    await handle.trigger('pointermove', { clientY: 280, pointerId: 1 });
    await handle.trigger('pointerup', { clientY: 280, pointerId: 1 });
    expect(view.emitted('update:solutionDetent')?.at(-1)).toEqual(['full']);
    await view.setProps({ solutionDetent: 'full' });
    await handle.trigger('keydown', { key: 'ArrowDown' });
    expect(view.emitted('update:solutionDetent')?.at(-1)).toEqual(['default']);
    view.get<HTMLButtonElement>('.q-selfassess button').element.focus();
    await view.get('.q-ssheet').trigger('keydown', { key: 'Escape' });
    expect(view.emitted('update:solutionDetent')?.at(-1)).toEqual(['collapsed']);
    expect(document.activeElement).toBe(handle.element);
  });

  it('drives AI dialog state independently of the open solution drawer', async () => {
    const view = mountReviewBar({ learningAvailable: true, learningLabel: 'Lösung erklären', learningOpen: false });
    const entry = view.get('.practice-bar__learning-toggle');
    expect(entry.attributes('aria-haspopup')).toBe('dialog');
    expect(entry.attributes('aria-expanded')).toBe('false');
    await entry.trigger('click');
    expect(view.emitted('learningToggle')).toHaveLength(1);
    expect(view.emitted('update:solutionDetent')).toBeUndefined();
    await view.setProps({ learningOpen: true, solutionDetent: 'collapsed' });
    expect(entry.attributes('aria-expanded')).toBe('true');
    expect(entry.classes()).toContain('practice-bar__learning-toggle--on');
  });

  it('uses custom review content in the measured default height and caps long content', async () => {
    let contentHeight = 260;
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('q-ssheet__review') ? contentHeight : 0;
      return { x: 0, y: 0, top: 0, bottom: height, left: 0, right: 800, width: 800, height, toJSON: () => ({}) };
    });
    const view = mount(SolutionSheet, {
      props: { solution: [], detent: 'default', handle: true, handleTitle: 'Lösung & Bewertung', topReserve: 56 },
      slots: { review: '<div>Lösung und Bewertung</div>' },
    });
    mounted.push(view);
    await nextTick(); await nextTick();
    const height = () => parseFloat(view.get<HTMLElement>('.q-ssheet').element.style.height);
    expect(height()).toBeGreaterThanOrEqual(260);
    expect(height()).toBeLessThan(300);
    contentHeight = 1200;
    resize();
    await nextTick();
    expect(height()).toBeLessThanOrEqual(460);
    const readingHeight = height();
    await view.setProps({ detent: 'full' });
    expect(height()).toBeGreaterThan(readingHeight);
    expect(height()).toBeLessThanOrEqual(window.innerHeight - 56 + 6);
    await view.setProps({ detent: 'collapsed' });
    expect(height()).toBe(0);
  });
});
