import { describe, expect, it } from 'vitest';

import settingsSource from '../src/routes/SettingsView.vue?raw';
import aiSettingsSource from '../src/routes/settings/AiSettings.vue?raw';
import desktopSettingsSource from '../src/routes/settings/DesktopSettings.vue?raw';
import desktopViewSource from '../src/routes/DesktopView.vue?raw';
import appSource from '../src/App.vue?raw';

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

  it('keeps Settings separate and gates the native control centre behind the shell capability', () => {
    expect(appSource).toContain('v-if="ports.shell.capabilities.desktop"');
    expect(appSource).toContain('data-desktop-capability-entry');
    expect(appSource).toContain('to="/desktop"');
    expect(desktopSettingsSource).toContain('v-if="isDesktopShell"');
    expect(desktopSettingsSource).toContain('ports.shell.capabilities.desktop');
    expect(settingsSource).not.toContain('DesktopSettings');
    expect(desktopViewSource).toContain('v-if="isDesktopShell"');
    expect(desktopViewSource).toContain('data-desktop-control-center');
    expect(desktopViewSource).toContain('<DesktopSettings :panel="panel" />');
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
