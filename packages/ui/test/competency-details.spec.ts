import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import type { CompetencyCatalog } from '@qed2/core-logic';
import CompetencyChip from '../src/shared/CompetencyChip.vue';
import CompetencyDetailsDialog from '../src/shared/CompetencyDetailsDialog.vue';
import PracticeQuestionHeader from '../src/practice/PracticeQuestionHeader.vue';
import CompetencyGroups from '../src/review/CompetencyGroups.vue';
import { provideCompetencyDetails } from '../src/shared/competencies.js';
import { setUiLocale, uiLocale } from '../src/i18n.js';

const views: VueWrapper[] = [];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(() => document.body);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 0; });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  views.splice(0).forEach(view => view.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  setUiLocale('de');
});

function catalog(locale: 'de' | 'en' = 'de'): CompetencyCatalog {
  return {
    schemaVersion: 1, id: 'srdp-mathematics-ahs', locale, version: '2024-11',
    textFormat: 'markdown+latex', title: 'Official catalogue', subtitle: 'Core competencies',
    source: { url: 'https://www.matura.gv.at/catalogue.pdf#old', sha256: 'a'.repeat(64), pageCount: 16, versionLabel: 'Stand: November 2024' },
    areas: [{
      code: 'WS', title: 'Wahrscheinlichkeit und Statistik',
      introduction: [{ text: 'An entire area introduction that should not be shown.', pages: [11] }],
      groups: [{
        code: 'WS 3', title: 'Normalverteilung mit $\\sigma > 0$', pages: [13],
        competencies: [
          { code: 'WS 3.4', text: '**Normalverteilung** und $\\sigma$ verstehen.', pages: [13], footnoteRefs: ['**'] },
          { code: 'WS 3.5', text: 'Another competency should not be shown.', pages: [13], footnoteRefs: ['**'] },
        ],
        comments: [
          { text: 'Group note with $x^2$.', pages: [13] },
          { text: 'This entry note.', pages: [13], competencyCodes: ['WS 3.4'] },
          { text: 'An unrelated entry note.', pages: [13], competencyCodes: ['WS 3.5'] },
        ],
        footnotes: [
          { marker: '**', text: 'gültig ab Haupttermin 2026/27 (Mai 2027)', pages: [13], competencyCodes: ['WS 3.4', 'WS 3.5'], effectiveFrom: { examSession: '2026/27', date: '2027-05' } },
          { marker: '*', text: 'An unrelated footnote.', pages: [13], competencyCodes: ['WS 3.5'] },
        ],
      }],
    }],
    contexts: { title: 'Contexts', blocks: [{ type: 'paragraph', text: 'Full context appendix should not be shown.', pages: [14] }] },
  };
}

function openDialog(overrides: Partial<InstanceType<typeof CompetencyDetailsDialog>['$props']> = {}) {
  const view = mount(CompetencyDetailsDialog, {
    props: { open: true, code: 'WS 3.4', locale: 'de', catalog: catalog(), loading: false, error: false, ...overrides },
    attachTo: document.body,
  });
  views.push(view);
  return view;
}

function dialog(): HTMLElement { return document.querySelector('[role="dialog"]')!; }

describe('CompetencyDetailsDialog', () => {
  it('shows only the requested official entry with rendered math and the original PDF page', () => {
    openDialog();
    expect(dialog().textContent).toContain('WS 3.4');
    expect(dialog().querySelector('.q-competency-dialog__group .katex')).not.toBeNull();
    expect(dialog().querySelector('.q-competency-dialog__description strong')?.textContent).toBe('Normalverteilung');
    expect(dialog().querySelector('.q-competency-dialog__description .katex')).not.toBeNull();
    expect(dialog().textContent).not.toContain('Another competency');
    expect(dialog().textContent).not.toContain('entire area introduction');
    expect(dialog().textContent).not.toContain('Full context appendix');
    const link = dialog().querySelector<HTMLAnchorElement>('.q-competency-dialog__source a')!;
    expect(link.href).toBe('https://www.matura.gv.at/catalogue.pdf#page=13');
    expect(link.rel).toBe('noopener noreferrer');
    expect(dialog().textContent).toContain('Stand: November 2024');
  });

  it('keeps applicability footnotes visible while collapsing only relevant notes', () => {
    openDialog();
    const notes = dialog().querySelector<HTMLDetailsElement>('.q-competency-dialog__notes')!;
    expect(notes.open).toBe(false);
    expect(notes.querySelector('summary')?.getAttribute('tabindex')).toBe('0');
    expect(notes.textContent).toContain('Group note');
    expect(notes.textContent).toContain('This entry note');
    expect(notes.textContent).not.toContain('unrelated');
    const footnote = dialog().querySelector('[role="note"]')!;
    expect(footnote.textContent).toContain('Mai 2027');
    expect(notes.contains(footnote)).toBe(false);
    expect(dialog().textContent).not.toContain('An unrelated footnote');
  });

  it('traps keyboard focus, closes on Escape and restores the opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'WS 3.4';
    document.body.append(opener);
    opener.focus();
    const view = openDialog({ open: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.classList.contains('q-modal-open')).toBe(false);
    await view.setProps({ open: true });
    await nextTick();
    expect(document.body.classList.contains('q-modal-open')).toBe(true);
    const last = dialog().querySelector<HTMLButtonElement>('.q-competency-dialog__footer button')!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(dialog().querySelector('button'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(view.emitted('close')).toHaveLength(1);
    await view.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
    expect(document.body.classList.contains('q-modal-open')).toBe(false);
  });

  it('switches only the requested description language and hides a mismatching catalog', async () => {
    const view = openDialog();
    dialog().querySelector<HTMLButtonElement>('[aria-label="English"]')!.click();
    expect(view.emitted('localeChange')).toEqual([['en']]);
    expect(uiLocale.value).toBe('de');
    await view.setProps({ locale: 'en', loading: true });
    expect(dialog().querySelector('[aria-label="English"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(dialog().querySelector('.q-competency-dialog__official')).toBeNull();
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(dialog().textContent).not.toContain('kein offizieller Eintrag');
    await view.setProps({ catalog: catalog('en'), loading: false });
    expect(dialog().querySelector('.q-competency-dialog__official')?.getAttribute('lang')).toBe('en');
    expect(uiLocale.value).toBe('de');
  });

  it('clearly separates a failed official lookup from a legacy question description and offers retry', () => {
    const view = openDialog({ catalog: null, error: true, fallbackDescription: 'Alte Beschreibung mit $x^2$.' });
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Katalog konnte nicht geladen');
    expect(dialog().querySelector('.q-competency-dialog__fallback-label')?.textContent).toBe('Beschreibung aus der Aufgabe');
    expect(dialog().querySelector('.q-competency-dialog__fallback .katex')).not.toBeNull();
    expect(dialog().querySelector('.q-competency-dialog__source')).toBeNull();
    dialog().querySelector<HTMLButtonElement>('.q-competency-dialog__error button')!.click();
    expect(view.emitted('retry')).toHaveLength(1);
  });

  it('gives an unknown code a concise empty state without claiming official provenance', () => {
    openDialog({ code: 'OTHER' });
    expect(dialog().querySelector('[role="status"]')?.textContent).toContain('kein offizieller Eintrag');
    expect(dialog().querySelector('.q-competency-dialog__official')).toBeNull();
    expect(dialog().querySelector('.q-competency-dialog__source')).toBeNull();
  });

  it('keeps HTML inert and does not expose an unsafe source link', () => {
    const unsafe = catalog();
    unsafe.source.url = 'javascript:alert(1)';
    unsafe.areas[0]!.groups[0]!.competencies[0]!.text = '<img src=x onerror="alert(1)"> [unsafe](javascript:alert(1))';
    openDialog({ catalog: unsafe });
    expect(dialog().querySelector('img, script, [onerror], a[href^="javascript:"]')).toBeNull();
    expect(dialog().querySelector('.q-competency-dialog__source a')).toBeNull();
    expect(dialog().textContent).toContain('<img');
  });

  it('keeps close controls outside the scrolling content and ignores clicks inside', () => {
    const view = openDialog();
    const body = dialog().querySelector('.q-competency-dialog__body')!;
    expect(body.textContent).not.toContain('Schließen');
    body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(view.emitted('close')).toBeUndefined();
    document.querySelector('.q-competency-dialog')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(view.emitted('close')).toHaveLength(1);
  });

  it('localizes controls without translating the supplied official content', () => {
    setUiLocale('en');
    openDialog();
    expect(dialog().textContent).toContain('Core competency');
    expect(dialog().textContent).toContain('Official catalogue (PDF)');
    expect(dialog().textContent).toContain('Normalverteilung');
  });
});

describe('CompetencyChip', () => {
  it('remains a static capsule without a shell detail provider', () => {
    const view = mount(CompetencyChip, { props: { code: 'AG 1.1', description: 'Zahlenmengen' } });
    views.push(view);
    expect(view.find('button').exists()).toBe(false);
    expect(view.get('.q-chip').text()).toBe('AG 1.1');
  });

  it('requests details on click without activating its parent row or keyboard shortcuts', async () => {
    const request = vi.fn();
    const parentClick = vi.fn();
    const parentDoubleClick = vi.fn();
    const parentKey = vi.fn();
    const view = mount(defineComponent({
      setup() {
        provideCompetencyDetails(request);
        return () => h('div', { onClick: parentClick, onDblclick: parentDoubleClick, onKeydown: parentKey, onKeyup: parentKey }, [
          h(CompetencyChip, { code: 'AG 1.1', description: 'Zahlenmengen' }),
        ]);
      },
    }));
    views.push(view);
    const button = view.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-haspopup')).toBe('dialog');
    await button.trigger('keydown', { key: 'Enter' });
    await button.trigger('keyup', { key: 'Enter' });
    await button.trigger('keydown', { key: ' ' });
    await button.trigger('keyup', { key: ' ' });
    expect(parentKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await button.trigger('click');
    expect(request).toHaveBeenCalledExactlyOnceWith({ code: 'AG 1.1', description: 'Zahlenmengen' });
    expect(parentClick).not.toHaveBeenCalled();
    await button.trigger('dblclick');
    expect(parentDoubleClick).not.toHaveBeenCalled();
  });

  it('passes the question header description into the shared detail request', async () => {
    const request = vi.fn();
    const view = mount(defineComponent({
      setup() {
        provideCompetencyDetails(request);
        return () => h(PracticeQuestionHeader, {
          title: 'Test question', competencyCodes: ['AG 1.1'], competencyDescriptions: { 'AG 1.1': 'Zahlenmengen' },
          sourceLine: '2026', format: '2 aus 5', starred: false,
        });
      },
    }));
    views.push(view);
    await view.get('.q-competency-chip').trigger('click');
    expect(request).toHaveBeenCalledExactlyOnceWith({ code: 'AG 1.1', description: 'Zahlenmengen' });
    expect(view.get('.q-chip--neutral').text()).toBe('2 aus 5');
  });

  it('keeps competency group detail buttons outside the mastery image and preserves its accessible name', async () => {
    const request = vi.fn();
    const view = mount(defineComponent({
      setup() {
        provideCompetencyDetails(request);
        return () => h(CompetencyGroups, { entries: [{ code: 'AG 1.1', mastery: 0.7 }] });
      },
    }));
    views.push(view);
    const bar = view.get('[role="img"]');
    expect(bar.attributes('aria-label')).toContain('AG 1.1');
    expect(bar.find('button').exists()).toBe(false);
    await view.get('.q-competency-chip').trigger('click');
    expect(request).toHaveBeenCalledExactlyOnceWith({ code: 'AG 1.1' });
  });
});
