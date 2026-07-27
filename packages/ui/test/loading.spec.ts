import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import QSkeleton from '../src/shared/QSkeleton.vue';
import QLoadingPanel from '../src/shared/QLoadingPanel.vue';

describe('shared loading system', () => {
  it('draws one placeholder per expected row at the caller’s row height', () => {
    const wrapper = mount(QSkeleton, { props: { rows: 4, height: '42px' } });
    const rows = wrapper.findAll('.q-skeleton-list__row');
    expect(rows).toHaveLength(4);
    // Matching the real row height is what keeps the list from jumping.
    expect(rows[0]!.attributes('style')).toContain('height: 42px');
  });

  it('announces the wait once and hides the decorative rows', () => {
    const wrapper = mount(QSkeleton, { props: { label: 'Verlauf wird geladen …' } });
    expect(wrapper.get('.q-skeleton-list').attributes('role')).toBe('status');
    expect(wrapper.get('.q-skeleton-list').attributes('aria-label')).toBe('Verlauf wird geladen …');
    for (const row of wrapper.findAll('.q-skeleton-list__row')) {
      expect(row.attributes('aria-hidden')).toBe('true');
    }
  });

  it('shares one shimmer surface between the row and the page variant', () => {
    // Both opt into `.q-skeleton`, defined once in tokens.css — that is what
    // makes a loading list and a loading page look like the same product.
    expect(mount(QSkeleton).get('.q-skeleton-list__row').classes()).toContain('q-skeleton');
    expect(mount(QLoadingPanel).get('.q-loadpanel__bar').classes()).toContain('q-skeleton');
  });

  it('lets a page-level panel drop its card when the caller draws one', () => {
    expect(mount(QLoadingPanel).classes()).not.toContain('q-loadpanel--bare');
    expect(mount(QLoadingPanel, { props: { bare: true } }).classes()).toContain(
      'q-loadpanel--bare',
    );
    expect(mount(QLoadingPanel, { props: { label: 'Lade …' } }).text()).toContain('Lade …');
  });
});
