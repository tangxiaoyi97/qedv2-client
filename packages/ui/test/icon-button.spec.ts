import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QIconButton from '../src/shared/QIconButton.vue';
import leaderboardDrawerSource from '../src/leaderboard/LeaderboardDetailDrawer.vue?raw';
import aiExplainSource from '../src/practice/AiExplainPanel.vue?raw';
import sessionDrawerSource from '../src/practice/PracticeSessionDrawer.vue?raw';
import filterDialogSource from '../src/question/FilterDialog.vue?raw';
import figureViewerSource from '../src/shared/FigureViewer.vue?raw';
import iconButtonSource from '../src/shared/QIconButton.vue?raw';
import tokenSource from '../src/styles/tokens.css?raw';

describe('QIconButton', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one consistently labelled Lucide close control and forwards host attributes', async () => {
    const wrapper = mount(QIconButton, {
      attrs: { 'aria-label': 'Schließen', class: 'dialog-close', 'data-autofocus': '' },
    });
    const button = wrapper.get('button');

    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-label')).toBe('Schließen');
    expect(button.attributes('data-autofocus')).toBe('');
    expect(button.classes()).toContain('q-icon-btn');
    expect(button.classes()).toContain('dialog-close');
    expect(button.find('.lucide-x').exists()).toBe(true);
    expect(button.text()).toBe('');

    await button.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
    expect(wrapper.emitted('click')?.[0]?.[0]).toBeInstanceOf(MouseEvent);
  });

  it('keeps a 44px target, a 20px baseline-free icon and token-based interaction states', () => {
    expect(tokenSource).toContain('--q-icon-control-size: 44px;');
    expect(tokenSource).toContain('--q-icon-glyph-size: 20px;');
    expect(iconButtonSource).toMatch(
      /\.q-icon-btn\s*{[^}]*width:\s*var\(--q-icon-control-size\);[^}]*height:\s*var\(--q-icon-control-size\);/s,
    );
    expect(iconButtonSource).toMatch(/\.q-icon-btn\s*{[^}]*line-height:\s*0;/s);
    expect(iconButtonSource).toContain(':size="20"');
    expect(iconButtonSource).toContain('background: var(--q-panel-2);');
    expect(iconButtonSource).toContain('outline: 2px solid var(--q-accent);');
  });

  it('exposes focus for dialogs that manage initial focus themselves', () => {
    const wrapper = mount(QIconButton, {
      attrs: { 'aria-label': 'Schließen' },
      attachTo: document.body,
    });

    (wrapper.vm as unknown as { focus: (options?: FocusOptions) => void }).focus({
      preventScroll: true,
    });
    expect(document.activeElement).toBe(wrapper.element);
    wrapper.unmount();
  });

  it('is the single icon-close implementation used by shared panels, drawers and viewers', () => {
    for (const source of [
      leaderboardDrawerSource,
      aiExplainSource,
      sessionDrawerSource,
      filterDialogSource,
      figureViewerSource,
    ]) {
      expect(source).toContain('QIconButton');
      expect(source).not.toContain('q-dialog-close');
      expect(source).not.toMatch(/<button[^>]*>\s*✕\s*<\/button>/s);
    }
  });
});
