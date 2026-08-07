import { describe, expect, it } from 'vitest';

import buttonSource from '../src/shared/QButton.vue?raw';

describe('QButton theme contract', () => {
  it('derives the primary hover shadow from the active accent theme', () => {
    expect(buttonSource).toContain('box-shadow: 0 4px 12px var(--q-accent-ring);');
    expect(buttonSource).not.toContain('rgba(142, 156, 73');
  });
});
