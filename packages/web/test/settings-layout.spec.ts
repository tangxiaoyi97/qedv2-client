import { describe, expect, it } from 'vitest';

import settingsSource from '../src/routes/SettingsView.vue?raw';

describe('settings appearance layout', () => {
  it('keeps the intrinsic theme-card height in normal document flow', () => {
    expect(settingsSource).toMatch(
      /\.settings__row--top\s*{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(settingsSource).toContain(
      'grid-template-columns: repeat(4, minmax(0, 1fr));',
    );
    expect(settingsSource).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    );
  });
});
