import { describe, expect, it } from 'vitest';

import settingsSource from '../src/routes/SettingsView.vue?raw';
import aiSettingsSource from '../src/routes/settings/AiSettings.vue?raw';

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

describe('AI settings information hierarchy', () => {
  it('keeps secondary disclosure and maintenance behind explicit summaries', () => {
    expect(aiSettingsSource).toContain('<summary>Datenschutz · Aufgabe und Antwort werden übertragen</summary>');
    expect(aiSettingsSource).toContain('<summary>Antwortstil</summary>');
    expect(aiSettingsSource).toContain('<summary>Daten &amp; Speicher</summary>');
    expect(aiSettingsSource).toContain(':open="!configured"');
  });

  it('makes selected modes explicit and does not offer arbitrary AI endpoints', () => {
    expect(aiSettingsSource).toContain('✓</span> Ausgewählt');
    expect(aiSettingsSource).not.toContain('ai-base');
    expect(aiSettingsSource).not.toContain('OpenRouter');
    expect(aiSettingsSource).not.toContain('Verlauf exportieren');
  });
});
