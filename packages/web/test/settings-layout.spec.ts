import { describe, expect, it } from 'vitest';

import settingsSource from '../src/routes/SettingsView.vue?raw';
import aiSettingsSource from '../src/routes/settings/AiSettings.vue?raw';
import desktopSettingsSource from '../src/routes/settings/DesktopSettings.vue?raw';
import settingsCardSource from '../src/routes/settings/SettingsCard.vue?raw';
import settingsRowSource from '../src/routes/settings/SettingsRow.vue?raw';
import desktopViewSource from '../src/routes/DesktopView.vue?raw';
import appSource from '../src/App.vue?raw';

describe('settings appearance layout', () => {
  it('uses one reusable control-panel grid for labels and right-aligned actions', () => {
    expect(settingsSource).toContain("import SettingsCard from './settings/SettingsCard.vue';");
    expect(settingsSource).toContain("import SettingsRow from './settings/SettingsRow.vue';");
    expect(settingsSource).toContain('<SettingsRow label="Aussehen">');
    expect(settingsSource).toContain('<SettingsRow label="Farbschema" layout="stacked">');
    expect(settingsRowSource).toContain('grid-template-columns: minmax(0, 1fr) auto;');
    expect(settingsRowSource).toContain('justify-self: end;');
    expect(settingsRowSource).toContain('@media (max-width: 520px)');
    expect(settingsRowSource).toContain('minmax(0, 1fr)');
    expect(settingsCardSource).toContain('var(--q-card)');
    expect(settingsCardSource).toContain('var(--q-border)');
  });

  it('keeps theme controls responsive, labelled and at least 44px tall', () => {
    expect(settingsSource).toContain(
      'grid-template-columns: repeat(4, minmax(0, 1fr));',
    );
    expect(settingsSource).toContain(
      'grid-template-columns: repeat(2, minmax(0, 1fr));',
    );
    expect(settingsSource).toContain('min-height: var(--q-control-height);');
    expect(settingsSource).toContain(':aria-labelledby="labelId"');
    expect(settingsSource).toContain('.settings__segment:focus-within');
    expect(settingsSource).toContain('name="settings-appearance"');
    expect(settingsSource).toContain('name="settings-colour-scheme"');
    expect(settingsSource).toContain('.settings__select:focus-visible');
  });

  it('removes decorative helper copy and keeps account actions concise', () => {
    expect(settingsSource).not.toContain('Erscheinungsbild');
    expect(settingsSource).not.toContain('Auch nachts angenehm');
    expect(settingsSource).not.toContain('Ruhige Flächen, abgestimmte Akzent- und Statusfarben');
    expect(settingsSource).not.toContain("ui.t('settingsLanguageHint')");
    expect(settingsSource).not.toContain('Manuelle Synchronisierung außerhalb des Auto-Syncs');
    expect(settingsSource).toContain('label="Archiv synchronisieren"');
    expect(settingsSource).toContain("'Jetzt hochladen'");
    expect(settingsSource).toContain('tone="danger"');
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
  it('uses shared rows and keeps editors and privacy details collapsed', () => {
    expect(aiSettingsSource).toContain("import SettingsCard from './SettingsCard.vue';");
    expect(aiSettingsSource).toContain("import SettingsRow from './SettingsRow.vue';");
    expect(aiSettingsSource).toContain('<SettingsCard title="KI-Erklärungen">');
    expect(aiSettingsSource).toContain('<SettingsRow v-if="ai.byoOffered || configured" label="API-Schlüssel">');
    expect(aiSettingsSource).toContain('aria-controls="ai-credential-editor"');
    expect(aiSettingsSource).toContain('aria-controls="ai-preferences-editor"');
    expect(aiSettingsSource).toContain('aria-controls="ai-privacy-details"');
    expect(aiSettingsSource).not.toContain('ai-set__overview');
    expect(aiSettingsSource).not.toContain('ai-set__readiness-detail');
    expect(aiSettingsSource).not.toContain('Nur auf deinen Klick.</strong>');
  });

  it('renders the source selector only when both sources are usable', () => {
    expect(aiSettingsSource).toContain('v-if="showSourceChooser" label="Quelle"');
    expect(aiSettingsSource).toContain('ai.poolOffered && ai.byoOffered');
    expect(aiSettingsSource).toContain('role="radiogroup" :aria-labelledby="labelId"');
    expect(aiSettingsSource).toContain('type="radio"');
    expect(aiSettingsSource).toContain('name="ai-source"');
    expect(aiSettingsSource).not.toContain('ai-set__mode--disabled');
    expect(aiSettingsSource).not.toContain('ai-base');
    expect(aiSettingsSource).not.toContain('OpenRouter');
    expect(aiSettingsSource).not.toContain('Verlauf exportieren');
  });
});
