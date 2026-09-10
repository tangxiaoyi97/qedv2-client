import { describe, expect, it } from 'vitest';

import settingsSource from '../src/routes/SettingsView.vue?raw';
import aiSettingsSource from '../src/routes/settings/AiSettings.vue?raw';
import desktopSettingsSource from '../src/routes/settings/DesktopSettings.vue?raw';
import settingsCardSource from '../src/routes/settings/SettingsCard.vue?raw';
import settingsRowSource from '../src/routes/settings/SettingsRow.vue?raw';
import sharedLayout from '../src/routes/settings/settings-layout.css?raw';
import desktopViewSource from '../src/routes/DesktopView.vue?raw';
import appSource from '../src/App.vue?raw';

describe('settings appearance layout', () => {
  it('does not reserve spacing for an empty status or description slot', () => {
    expect(settingsRowSource).toContain('.q-settings-row__status:empty,');
    expect(settingsRowSource).toContain('.q-settings-row__description:empty');
    expect(settingsRowSource).toContain('display: none;');
  });
  it('uses one reusable control-panel grid for labels and right-aligned actions', () => {
    expect(settingsSource).toContain("import SettingsCard from './settings/SettingsCard.vue';");
    expect(settingsSource).toContain("import SettingsRow from './settings/SettingsRow.vue';");
    expect(settingsSource).toContain('<SettingsRow class="settings__appearance-row" :label="t(\'Aussehen\')">');
    expect(settingsSource).toContain('<SettingsRow :label="t(\'Farbschema\')" layout="stacked">');
    expect(settingsRowSource).toContain('grid-template-columns: minmax(0, 1fr) auto;');
    expect(settingsRowSource).toContain('justify-self: end;');
    expect(settingsRowSource).not.toContain('@media');
    expect(settingsRowSource).toContain('minmax(0, 1fr)');
    expect(settingsCardSource).toContain('var(--q-card)');
    expect(settingsCardSource).toContain('var(--q-border)');
  });

  it('keeps theme controls responsive, labelled and at least 44px tall', () => {
    expect(settingsSource).toContain(
      'grid-template-columns: repeat(4, minmax(0, 1fr));',
    );
    expect(settingsSource).toContain('height: 28px;');
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
    expect(settingsSource).toContain(':label="t(\'Archiv\')"');
    expect(settingsSource).toContain("t('Synchronisieren')");
    expect(settingsSource).toContain(':loading="uploading"');
    expect(settingsSource).not.toContain('Lokaler Fortschritt bleibt erhalten');
    expect(settingsSource).not.toContain('Als Gast unterwegs —');
    expect(settingsSource).not.toContain('settings__vsub');
    expect(settingsSource).toContain('tone="danger"');
  });

  it('shares card, editor and control geometry without narrow-screen padding overrides', () => {
    expect(settingsCardSource).toContain("import './settings-layout.css';");
    expect(sharedLayout).toContain('--q-settings-inset: var(--q-space-4);');
    expect(sharedLayout).toContain('--q-settings-block: var(--q-space-3);');
    for (const source of [settingsCardSource, settingsRowSource, settingsSource, aiSettingsSource, desktopSettingsSource]) {
      expect(source).toContain('padding: var(--q-settings-block) var(--q-settings-inset);');
    }
    for (const source of [settingsSource, aiSettingsSource]) {
      expect(source).toContain('q-settings-field');
      expect(source).toContain('q-settings-segments');
      expect(source).toContain('q-settings-segment');
      expect(source).not.toMatch(/\.settings__segment\s*\+\s*\.settings__segment--on/);
      expect(source).not.toMatch(/\.ai-settings__segment\s*\+\s*\.ai-settings__segment--on/);
    }
    expect(sharedLayout).toContain('height: var(--q-control-height);');
    expect(sharedLayout).toContain('font-size: var(--q-font-input);');
    expect(sharedLayout).toContain('font-size: var(--q-font-ui);');
    expect(sharedLayout).toContain('border-radius: var(--q-radius-control);');
  });

  it('shows isolated local data only when present and requires explicit recovery', () => {
    expect(settingsSource).toContain('v-if="(recoveryInventory?.totalCount ?? 0) > 0"');
    expect(settingsSource).toContain(':label="t(\'Lokale Daten\')"');
    expect(settingsSource).toContain('Nicht automatisch zugeordnet.');
    expect(settingsSource).toContain('v-if="profile.assignment.safe');
    expect(settingsSource).toContain('Diesem Profil zuordnen?');
    expect(settingsSource).toContain('Nur Export');
    expect(settingsSource).toContain("candidate.kind === 'unclaimed-guest'");
    expect(settingsSource).toContain('progress.claimGuestAttempts');
    expect(settingsSource).toContain("? t('Besucherdaten')");
    expect(settingsSource).toContain('aria-labelledby="recovery-title"');
    expect(settingsSource).toContain('width: min(440px, calc(100vw - 24px));');
    expect(settingsSource).toContain('@media (max-width: 360px)');
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
    expect(desktopViewSource).not.toContain('desktop-view__title');
    expect(desktopSettingsSource).not.toContain('Parallel arbeiten');
    expect(desktopSettingsSource).not.toContain('Die Quellenwahl betrifft ausschließlich');
    expect(desktopSettingsSource).toContain('Unsigniert · manuelle Installation');
  });
});

describe('AI settings information hierarchy', () => {
  it('uses shared rows and keeps editors and privacy details collapsed', () => {
    expect(aiSettingsSource).toContain("import SettingsCard from './SettingsCard.vue';");
    expect(aiSettingsSource).toContain("import SettingsRow from './SettingsRow.vue';");
    expect(aiSettingsSource).toContain('<SettingsCard :title="t(\'KI-Erklärungen\')">');
    expect(aiSettingsSource).toContain('<SettingsRow :label="t(\'API-Schlüssel\')">');
    expect(aiSettingsSource).toContain('aria-controls="ai-credential-editor"');
    expect(aiSettingsSource).toContain('aria-controls="ai-preferences-editor"');
    expect(aiSettingsSource).toContain('aria-controls="ai-privacy-details"');
    expect(aiSettingsSource).not.toContain('ai-set__overview');
    expect(aiSettingsSource).not.toContain('ai-set__readiness-detail');
    expect(aiSettingsSource).not.toContain('description="Nur auf deinen Klick"');
    expect(aiSettingsSource).not.toContain('description="Antworten auf diesem Gerät"');
  });

  it('renders the source selector only when both sources are usable', () => {
    expect(aiSettingsSource).toContain('v-if="showSourceChooser" class="ai-settings__source-row" :label="t(\'Quelle\')"');
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
