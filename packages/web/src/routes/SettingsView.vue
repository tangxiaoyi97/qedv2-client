<script setup lang="ts">
/**
 * Einstellungen (prototype 4c): theme, language, advanced server addresses
 * (collapsed), version info, logout. The disabled update button is the
 * reserved seam for the desktop shell's UpdatePort.
 */
import { reactive, ref, watch } from 'vue';
import { DEFAULT_CONFIG } from '@qed2/core-logic';
import { CollapsePanel, QButton } from '@qed2/ui';
import { APP_VERSION } from '../services.js';
import { useAppStore, type ThemePref } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';

const app = useAppStore();
const auth = useAuthStore();

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
  { value: 'system', label: 'System' },
];

const form = reactive({
  coreBaseUrl: app.config.coreBaseUrl,
  serverBaseUrl: app.config.serverBaseUrl,
  bankRepoUrl: app.config.bankRepoUrl,
});
watch(
  () => app.config,
  (c) => {
    form.coreBaseUrl = c.coreBaseUrl;
    form.serverBaseUrl = c.serverBaseUrl;
    form.bankRepoUrl = c.bankRepoUrl;
  },
);

const saved = ref(false);
const saving = ref(false);

async function saveServers(): Promise<void> {
  saving.value = true;
  try {
    await app.updateConfig({
      coreBaseUrl: form.coreBaseUrl.trim(),
      serverBaseUrl: form.serverBaseUrl.trim(),
      bankRepoUrl: form.bankRepoUrl.trim(),
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } finally {
    saving.value = false;
  }
}

async function resetServers(): Promise<void> {
  form.coreBaseUrl = DEFAULT_CONFIG.coreBaseUrl;
  form.serverBaseUrl = DEFAULT_CONFIG.serverBaseUrl;
  form.bankRepoUrl = DEFAULT_CONFIG.bankRepoUrl;
  await saveServers();
}

async function doLogout(): Promise<void> {
  await auth.logout();
}
</script>

<template>
  <div class="settings">
    <h1 class="settings__title">Einstellungen</h1>

    <div class="settings__row">
      <div>
        <div class="settings__row-title">Erscheinungsbild</div>
        <div class="settings__row-sub">Auch nachts angenehm</div>
      </div>
      <div class="settings__segments" role="radiogroup" aria-label="Erscheinungsbild">
        <button
          v-for="t in THEMES"
          :key="t.value"
          type="button"
          class="settings__segment"
          :class="{ 'settings__segment--on': app.theme === t.value }"
          role="radio"
          :aria-checked="app.theme === t.value"
          @click="app.setTheme(t.value)"
        >
          {{ t.label }}
        </button>
      </div>
    </div>

    <div class="settings__row">
      <div>
        <div class="settings__row-title">Sprache</div>
        <div class="settings__row-sub">Oberfläche</div>
      </div>
      <select class="settings__select" disabled aria-label="Sprache">
        <option>Deutsch</option>
      </select>
    </div>

    <div class="settings__divider" />

    <CollapsePanel title="Erweitert · Serveradressen" subtitle="nur für Fortgeschrittene">
      <div class="settings__adv">
        <div class="settings__warn">
          Standardwerte sind bereits gesetzt. Nur ändern, wenn du einen eigenen Server nutzt.
        </div>
        <label class="settings__field">
          <span class="settings__label">Inhalts-Server (core)</span>
          <input v-model="form.coreBaseUrl" class="settings__input" spellcheck="false" />
        </label>
        <label class="settings__field">
          <span class="settings__label">Nutzer-Server (sync)</span>
          <input v-model="form.serverBaseUrl" class="settings__input" spellcheck="false" />
        </label>
        <label class="settings__field">
          <span class="settings__label">Aufgaben-Datenbank (Repository)</span>
          <input v-model="form.bankRepoUrl" class="settings__input" spellcheck="false" />
        </label>
        <div class="settings__adv-actions">
          <QButton variant="ghost" :disabled="saving" @click="resetServers">Zurücksetzen auf Standard</QButton>
          <QButton :disabled="saving" @click="saveServers">{{ saved ? '✓ Übernommen' : 'Übernehmen' }}</QButton>
        </div>
      </div>
    </CollapsePanel>

    <div class="settings__divider" />

    <div class="settings__row">
      <div>
        <div class="settings__row-title">Version {{ APP_VERSION }} <span class="settings__dim">(Web)</span></div>
        <div class="settings__row-sub">
          <template v-if="app.coreInfo">
            Core {{ app.coreInfo.version }} · {{ app.coreInfo.bank.questionCount }} Aufgaben
            ({{ app.coreInfo.bank.playableCount }} spielbar) · Schema
            {{ app.coreInfo.schemaVersionSupported.min }}–{{ app.coreInfo.schemaVersionSupported.max }}
          </template>
          <template v-else-if="app.online">Core-Info wird geladen …</template>
          <template v-else>Offline — Core-Info nicht verfügbar</template>
        </div>
      </div>
      <button type="button" class="settings__update" disabled title="Updates in der Desktop-App">
        Nach Updates suchen
      </button>
    </div>

    <div class="settings__account">
      <template v-if="auth.isLoggedIn">
        <div>
          <div class="settings__row-title">Abmelden</div>
          <div class="settings__row-sub">Lokaler Fortschritt bleibt erhalten</div>
        </div>
        <QButton variant="danger" @click="doLogout">Abmelden</QButton>
      </template>
      <template v-else>
        <div>
          <div class="settings__row-title">Konto</div>
          <div class="settings__row-sub">Als Gast unterwegs — Anmelden aktiviert die Synchronisierung</div>
        </div>
        <RouterLink to="/anmelden" class="settings__login-link">Anmelden</RouterLink>
      </template>
    </div>
  </div>
</template>

<style scoped>
.settings {
  max-width: 560px;
  margin: 0 auto;
  padding: 26px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.settings__title {
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.01em;
  margin: 0 0 4px;
}
.settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.settings__row-title {
  font-size: 13.5px;
  font-weight: 600;
}
.settings__row-sub {
  font-size: 11.5px;
  color: var(--q-faint);
  margin-top: 2px;
  max-width: 340px;
}
.settings__dim {
  font-weight: 400;
  color: var(--q-faint);
}
.settings__segments {
  display: flex;
  border: 1px solid var(--q-btn-border);
  border-radius: 8px;
  overflow: hidden;
}
.settings__segment {
  padding: 7px 13px;
  font-size: 12px;
  font-weight: 600;
  color: var(--q-mut-2);
  background: var(--q-card);
  border: none;
  cursor: pointer;
  font-family: inherit;
}
.settings__segment + .settings__segment {
  border-left: 1px solid var(--q-btn-border);
}
.settings__segment--on {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 700;
}
.settings__select {
  padding: 8px 13px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  font-size: 12.5px;
  font-weight: 600;
}
.settings__divider {
  height: 1px;
  background: var(--q-border);
}
.settings__adv {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.settings__warn {
  padding: 9px 12px;
  background: var(--q-part-bg);
  border: 1px solid var(--q-part-border);
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--q-part-ink);
  line-height: 1.5;
}
.settings__field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.settings__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--q-mut);
}
.settings__input {
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  padding: 9px 11px;
  font: 500 12px ui-monospace, Menlo, monospace;
  color: var(--q-ink);
  background: var(--q-card);
}
.settings__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 8px 10px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
}
.settings__adv-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.settings__update {
  padding: 8px 13px;
  border: 1px solid var(--q-border-2);
  border-radius: 8px;
  font-size: 12px;
  color: var(--q-disabled);
  background: var(--q-page);
  cursor: not-allowed;
  font-family: inherit;
}
.settings__account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 10px;
  flex-wrap: wrap;
}
.settings__login-link {
  border: 1px solid var(--q-btn-border);
  background: var(--q-panel);
  color: var(--q-ink);
  font-weight: 600;
  font-size: 12.5px;
  padding: 8px 15px;
  border-radius: 8px;
  text-decoration: none;
}
</style>
