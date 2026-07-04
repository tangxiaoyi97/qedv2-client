<script setup lang="ts">
/**
 * Einstellungen (prototype 4c): theme, language, advanced server addresses
 * (collapsed), version info for ALL services (web / core / server), manual
 * archive upload (supplement §9), logout. The disabled update button is the
 * reserved seam for the desktop shell's UpdatePort.
 */
import { computed, reactive, ref, watch } from 'vue';
import { DEFAULT_CONFIG } from '@qed2/core-logic';
import { CollapsePanel, QButton } from '@qed2/ui';
import { APP_VERSION } from '../services.js';
import { LOCALE_LABELS, type Locale } from '../i18n.js';
import { useAppStore, type ThemePref } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useProgressStore } from '../stores/progress.js';
import { useUiStore } from '../stores/ui.js';

const app = useAppStore();
const auth = useAuthStore();
const progress = useProgressStore();
const ui = useUiStore();

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
  { value: 'system', label: 'System' },
];
const LOCALES: Locale[] = ['de', 'en'];

function onLocaleChange(ev: Event): void {
  ui.setLocale((ev.target as HTMLSelectElement).value as Locale);
}

const form = reactive({
  coreBaseUrl: app.config.coreBaseUrl,
  serverBaseUrl: app.config.serverBaseUrl,
  coreRepoUrl: app.config.coreRepoUrl,
  bankRepoUrl: app.config.bankRepoUrl,
});
watch(
  () => app.config,
  (c) => {
    form.coreBaseUrl = c.coreBaseUrl;
    form.serverBaseUrl = c.serverBaseUrl;
    form.coreRepoUrl = c.coreRepoUrl;
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
      coreRepoUrl: form.coreRepoUrl.trim(),
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
  form.coreRepoUrl = DEFAULT_CONFIG.coreRepoUrl;
  form.bankRepoUrl = DEFAULT_CONFIG.bankRepoUrl;
  await saveServers();
}

/** de-AT build stamp, e.g. „04.07.2026, 14:30". */
function formatBuildTime(iso: string): string {
  return new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

const coreLine = computed(() => {
  const info = app.coreInfo;
  if (!info) return 'Core nicht erreichbar';
  return `Core ${info.version} · Aufgabenbank ${info.bank.commit.slice(0, 7)} · ${info.bank.questionCount} Aufgaben`;
});

const serverLine = computed(() => {
  const info = app.serverInfo;
  if (!info) return 'Server nicht erreichbar';
  return `Server ${info.version}`;
});

/* manual archive upload (supplement §9) */
const uploading = ref(false);
const uploadTried = ref(false);

async function uploadNow(): Promise<void> {
  if (uploading.value) return;
  uploading.value = true;
  uploadTried.value = true;
  try {
    await progress.syncNow({ quiet: false });
  } catch {
    // syncStatus already reflects the failure; the line below shows it.
  } finally {
    uploading.value = false;
  }
}

const uploadStatus = computed(() => {
  if (!uploadTried.value) return '';
  const s = progress.syncStatus;
  switch (s.state) {
    case 'syncing':
      return '⟳ Wird hochgeladen …';
    case 'synced':
      return `✓ Synchronisiert ${s.at ? new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' }).format(s.at) : ''}`.trim();
    case 'conflict':
      return '⚠ Konflikt — der Dialog öffnet sich';
    case 'offline':
      return 'Offline — bitte später erneut versuchen.';
    case 'error':
      return `Fehler: ${s.message ?? 'unbekannt'}`;
    default:
      return '';
  }
});

async function doLogout(): Promise<void> {
  await auth.logout();
}
</script>

<template>
  <div class="settings">
    <h1 class="settings__title">Einstellungen</h1>

    <section class="settings__section">
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

      <div class="settings__account-sep" />

      <div class="settings__row">
        <div>
          <div class="settings__row-title">{{ ui.t('settingsLanguage') }}</div>
          <div class="settings__row-sub">{{ ui.t('settingsLanguageHint') }}</div>
        </div>
        <select
          class="settings__select"
          aria-label="Sprache"
          :value="ui.locale"
          @change="onLocaleChange"
        >
          <option v-for="locale in LOCALES" :key="locale" :value="locale">
            {{ LOCALE_LABELS[locale] }}
          </option>
        </select>
      </div>
    </section>

    <section class="settings__section">
      <div class="settings__versions-head">
        <div>
          <div class="settings__row-title">Versionen</div>
          <div class="settings__row-sub">Systeminformationen</div>
        </div>
        <QButton variant="ghost" @click="app.refreshServiceInfo()" title="Dienst-Infos neu laden">
          ⟳ Aktualisieren
        </QButton>
      </div>
      <div class="settings__versions">
        <div class="settings__version-line">
          Web-App {{ APP_VERSION }}
        </div>
        <div class="settings__version-line" :class="{ 'settings__version-line--dim': !app.coreInfo }">
          {{ coreLine }}
          <span v-if="app.coreInfo?.buildTime" class="settings__build">· Build {{ formatBuildTime(app.coreInfo.buildTime) }}</span>
        </div>
        <div class="settings__version-line" :class="{ 'settings__version-line--dim': !app.serverInfo }">
          {{ serverLine }}
          <span v-if="app.serverInfo?.buildTime" class="settings__build">· Build {{ formatBuildTime(app.serverInfo.buildTime) }}</span>
        </div>
        <QButton variant="secondary" disabled title="Updates in der Desktop-App" class="settings__update-btn">
          Nach Updates suchen
        </QButton>
      </div>
    </section>

    <section class="settings__section">
      <template v-if="auth.isLoggedIn">
        <div class="settings__row">
          <div>
            <div class="settings__row-title">Archiv jetzt hochladen</div>
            <div class="settings__row-sub">Manuelle Synchronisierung außerhalb des Auto-Syncs</div>
          </div>
          <QButton variant="secondary" :disabled="uploading" @click="uploadNow">
            {{ uploading ? 'Lädt hoch …' : 'Archiv jetzt hochladen' }}
          </QButton>
        </div>
        <div v-if="uploadStatus" class="settings__sync-status" role="status">{{ uploadStatus }}</div>
        <div class="settings__account-sep" />
        <div class="settings__row">
          <div>
            <div class="settings__row-title">Abmelden</div>
            <div class="settings__row-sub">Lokaler Fortschritt bleibt erhalten</div>
          </div>
          <QButton variant="danger" @click="doLogout">Abmelden</QButton>
        </div>
      </template>
      <template v-else>
        <div class="settings__row">
          <div>
            <div class="settings__row-title">Konto</div>
            <div class="settings__row-sub">Als Gast unterwegs — Anmelden aktiviert die Synchronisierung</div>
          </div>
          <QButton @click="ui.openAuthModal()">Anmelden</QButton>
        </div>
      </template>
    </section>

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
        <div class="settings__group-note">
          Bezugsquellen für Desktop/iOS: Von diesen Git-Repositories klonen und
          aktualisieren die App-Versionen mit Offline-Betrieb ihren lokalen
          Core und die Aufgabenbank. Die Web-Version nutzt sie nicht selbst.
        </div>
        <label class="settings__field">
          <span class="settings__label">Core-Quellcode (Repository)</span>
          <input v-model="form.coreRepoUrl" class="settings__input" spellcheck="false" />
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
.settings__section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 12px;
}
.settings__adv {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.settings__group-note {
  font-size: 11px;
  color: var(--q-faint);
  line-height: 1.5;
  padding-top: 4px;
  border-top: 1px dashed var(--q-border);
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
  background: var(--q-panel);
}
.settings__input:focus {
  outline: none;
  border: 2px solid var(--q-accent);
  padding: 8px 10px;
  box-shadow: 0 0 0 3px var(--q-accent-ring);
  background: var(--q-card);
}
.settings__adv-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.settings__versions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings__versions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.settings__version-line {
  font-size: 12px;
  color: var(--q-mut);
  padding-left: 2px;
}
.settings__version-line--dim {
  color: var(--q-faint);
}
.settings__build {
  color: var(--q-faint);
}
.settings__update-btn {
  align-self: flex-start;
  margin-top: 8px;
}
.settings__account-sep {
  height: 1px;
  background: var(--q-border-soft);
  margin: 2px 0;
}
.settings__sync-status {
  font-size: 12px;
  color: var(--q-mut);
  padding: 10px 14px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 8px;
}
</style>
