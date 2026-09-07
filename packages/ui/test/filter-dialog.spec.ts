import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import FilterDialog, { emptyFilterState } from '../src/question/FilterDialog.vue';

describe('FilterDialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows a compact result count and closes through Anzeigen', async () => {
    const wrapper = mount(FilterDialog, {
      attachTo: document.body,
      props: {
        modelValue: emptyFilterState(),
        resultCount: 3,
      },
    });

    expect(document.body.textContent).toContain('3 Treffer');
    expect(document.body.querySelector('.fdlg__count')?.getAttribute('role')).toBe('status');
    expect(document.body.querySelector('.fdlg__count')?.getAttribute('aria-label')).toBe('3 Treffer');
    expect(document.body.textContent).not.toContain('entsprechen');
    expect(document.body.textContent).toContain('Markiert ★');
    expect(document.body.textContent).not.toContain('Nur markierte');
    expect(document.body.textContent).toContain('Leeren');
    expect(document.body.textContent).not.toContain('Zurücksetzen');

    await wrapper.setProps({ resultCount: 1 });
    expect(document.body.textContent).toContain('1 Treffer');
    expect(document.body.querySelector('.fdlg__count')?.getAttribute('aria-label')).toBe('1 Treffer');

    const show = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Anzeigen');
    expect(show).toBeDefined();
    show?.click();
    expect(wrapper.emitted('close')).toHaveLength(1);

    wrapper.unmount();
  });
});
