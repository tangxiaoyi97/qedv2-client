<script setup lang="ts">
/**
 * Einstellungen (prototype 4c): theme, language, advanced server addresses
 * (collapsed), version info for ALL services (web / core / server), manual
 * archive upload (supplement §9), logout. The disabled update button is the
 * reserved seam for the desktop shell's UpdatePort.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { DEFAULT_CONFIG } from '@qed2/core-logic';
import { ChevronDown, CollapsePanel, QButton } from '@qed2/ui';
import { APP_VERSION } from '../services.js';
import { LOCALE_ENABLED, LOCALE_LABELS, type Locale } from '../i18n.js';
import { ACCENTS, currentAccent, setAccent, type AccentId } from '../platform/theme.js';
import { useModalA11y } from '../composables/useModalA11y.js';
import { useAppStore, type ThemePref } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useLeaderboardStore } from '../stores/leaderboard.js';
import { useProgressStore } from '../stores/progress.js';
import { useUiStore } from '../stores/ui.js';
import { databaseSchemaLabel, databaseStatusLabel, shortCommit } from '../version-info.js';

const app = useAppStore();
const auth = useAuthStore();
const leaderboard = useLeaderboardStore();
const progress = useProgressStore();
const ui = useUiStore();
const router = useRouter();

/* ---- Versionen: rows are clickable, each opens a detail modal ---- */
const versionDetail = ref<'web' | 'core' | 'server' | null>(null);

onMounted(() => {
  if (auth.isLoggedIn) void leaderboard.refreshProfile();
});
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) void leaderboard.refreshProfile();
    else leaderboard.clear();
  },
);

interface DetailRow {
  label: string;
  value: string;
  link?: string;
}
const versionDetailRows = computed<DetailRow[]>(() => {
  if (versionDetail.value === 'web') {
    return [
      { label: 'Dienst', value: 'qed2-client (Web-App)' },
      { label: 'Version', value: APP_VERSION },
      { label: 'Commit', value: ui.appCommit },
      { label: 'Repository', value: 'github.com/tangxiaoyi97/qedv2-client', link: 'https://github.com/tangxiaoyi97/qedv2-client' },
    ];
  }
  if (versionDetail.value === 'core') {
    const i = app.coreInfo;
    if (!i) return [{ label: 'Status', value: 'nicht erreichbar' }];
    return [
      { label: 'Dienst', value: i.service },
      { label: 'Version', value: i.version },
      { label: 'Core-Commit', value: i.commit ?? 'unbekannt' },
      { label: 'Core-Repository', value: i.sourceRepo.replace('https://github.com/', 'github.com/'), link: i.sourceRepo },
      { label: 'Build', value: formatBuildTime(i.buildTime) },
      { label: 'Unterstützte Bank-Schemas', value: `${i.schemaVersionSupported.min} – ${i.schemaVersionSupported.max}` },
      { label: 'Bank-Commit', value: i.bank.commit ?? 'unbekannt' },
      { label: 'Bank-Repository', value: i.bank.repo.replace('https://github.com/', 'github.com/'), link: i.bank.repo },
      { label: 'Bank-Branch', value: i.bank.branch },
      { label: 'Aufgaben', value: `${i.bank.questionCount} insgesamt · ${i.bank.playableCount} verfügbar` },
    ];
  }
  if (versionDetail.value === 'server') {
    const i = app.serverInfo;
    if (!i) return [{ label: 'Status', value: 'nicht erreichbar' }];
    return [
      { label: 'Dienst', value: i.service },
      { label: 'Version', value: i.version },
      { label: 'Server-Commit', value: i.commit ?? 'unbekannt' },
      { label: 'Server-Repository', value: i.sourceRepo.replace('https://github.com/', 'github.com/'), link: i.sourceRepo },
      { label: 'Build', value: formatBuildTime(i.buildTime) },
      { label: 'Datenbank-Status', value: databaseStatusLabel(i.database?.status) },
      { label: 'Datenbank-System', value: 'PostgreSQL' },
      { label: 'Schema-Version', value: i.database?.schemaVersion == null ? 'unbekannt' : `Schema ${i.database.schemaVersion}` },
      { label: 'Letzte Migration', value: i.database?.latestMigration ?? 'unbekannt' },
      { label: 'Auth', value: i.auth },
    ];
  }
  return [];
});
const versionDetailTitle = computed(() =>
  versionDetail.value === 'web' ? 'Web-App' : versionDetail.value === 'core' ? 'Core' : 'Server',
);

const detailCard = ref<HTMLElement | null>(null);
useModalA11y(detailCard, computed(() => versionDetail.value !== null), () => (versionDetail.value = null));

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
  { value: 'system', label: 'System' },
];
const LOCALES: Locale[] = ['de', 'en'];

/* accent color — built-in overlay palettes (see platform/theme.ts) */
const accent = ref<AccentId>(currentAccent());
function pickAccent(id: AccentId): void {
  accent.value = id;
  setAccent(id);
}

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
const urlError = ref('');

/** Only absolute http(s) URLs are meaningful server addresses — catch typos
 *  (missing scheme, stray spaces) before they wedge the whole app. */
function validHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateUrls(): string {
  const fields: [string, string][] = [
    ['Core-Adresse', form.coreBaseUrl.trim()],
    ['Server-Adresse', form.serverBaseUrl.trim()],
    ['Core-Repository', form.coreRepoUrl.trim()],
    ['Aufgabenbank-Repository', form.bankRepoUrl.trim()],
  ];
  for (const [label, value] of fields) {
    if (value === '') return `${label} darf nicht leer sein.`;
    if (!validHttpUrl(value)) return `${label}: „${value}“ ist keine gültige URL (https://…).`;
  }
  return '';
}

async function saveServers(): Promise<void> {
  urlError.value = validateUrls();
  if (urlError.value) return;
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

/** „Was ist neu" button — re-opens this build's changelog if one exists. */
const changelogState = ref<'idle' | 'loading' | 'none'>('idle');
async function openChangelog(): Promise<void> {
  changelogState.value = 'loading';
  const found = await ui.showCurrentChangelog();
  changelogState.value = found ? 'idle' : 'none';
  if (!found) setTimeout(() => (changelogState.value = 'idle'), 2500);
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

      <div class="settings__row settings__row--top">
        <div>
          <div class="settings__row-title">Farbschema</div>
          <div class="settings__row-sub">Ruhige Flächen, abgestimmte Akzent- und Statusfarben</div>
        </div>
        <div class="settings__themes" role="radiogroup" aria-label="Farbschema">
          <button
            v-for="a in ACCENTS"
            :key="a.id"
            type="button"
            class="settings__theme"
            :class="{ 'settings__theme--on': accent === a.id }"
            :data-accent="a.id"
            role="radio"
            :aria-checked="accent === a.id"
            :title="a.label"
            @click="pickAccent(a.id)"
          >
            <span class="settings__theme-preview" aria-hidden="true">
              <span class="settings__theme-card">
                <span class="settings__theme-line" />
                <span class="settings__theme-line settings__theme-line--mut" />
                <span class="settings__theme-action" />
              </span>
            </span>
            <span class="settings__theme-name">{{ a.label }}</span>
          </button>
        </div>
      </div>

      <div class="settings__row">
        <div>
          <div class="settings__row-title">{{ ui.t('settingsLanguage') }}</div>
          <div class="settings__row-sub">{{ ui.t('settingsLanguageHint') }}</div>
        </div>
        <span class="settings__select-wrap">
          <select
            class="settings__select"
            aria-label="Sprache"
            :value="ui.locale"
            @change="onLocaleChange"
          >
            <option v-for="locale in LOCALES" :key="locale" :value="locale" :disabled="!LOCALE_ENABLED[locale]">
              {{ LOCALE_LABELS[locale] }}
            </option>
          </select>
          <ChevronDown class="settings__select-chevron" />
        </span>
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
      <div class="settings__vlist">
        <button type="button" class="settings__vrow" @click="versionDetail = 'web'">
          <div class="settings__vmain">
            <div class="settings__vname">Web-App</div>
            <a
              class="settings__vsub settings__vlink"
              href="https://github.com/tangxiaoyi97/qedv2-client"
              target="_blank"
              rel="noopener noreferrer"
              @click.stop
            >github.com/tangxiaoyi97/qedv2-client</a>
          </div>
          <div class="settings__vver">
            <b>{{ APP_VERSION }}</b>
            <span v-if="ui.appCommit !== 'dev'" class="settings__vmeta">{{ ui.appCommit.slice(0, 7) }}</span>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
        <button type="button" class="settings__vrow" @click="versionDetail = 'core'">
          <div class="settings__vmain">
            <div class="settings__vname">Core</div>
            <div class="settings__vsub">
              <template v-if="app.coreInfo">Inhalte · {{ app.coreInfo.bank.questionCount }} Aufgaben</template>
              <template v-else>nicht erreichbar</template>
            </div>
          </div>
          <div class="settings__vver">
            <b>{{ app.coreInfo?.version ?? '—' }}</b>
            <span v-if="app.coreInfo" class="settings__vmeta">{{ shortCommit(app.coreInfo.commit) }}</span>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
        <button type="button" class="settings__vrow" @click="versionDetail = 'server'">
          <div class="settings__vmain">
            <div class="settings__vname">Server</div>
            <div class="settings__vsub">
              <template v-if="app.serverInfo">{{ databaseSchemaLabel(app.serverInfo.database) }}</template>
              <template v-else>nicht erreichbar</template>
            </div>
          </div>
          <div class="settings__vver">
            <b>{{ app.serverInfo?.version ?? '—' }}</b>
            <span v-if="app.serverInfo" class="settings__vmeta">{{ shortCommit(app.serverInfo.commit) }}</span>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
      </div>
      <div class="settings__versions-actions">
        <QButton variant="secondary" :disabled="changelogState === 'loading'" @click="openChangelog">
          {{ changelogState === 'none' ? 'Keine Hinweise für diesen Build' : 'Was ist neu' }}
        </QButton>
        <QButton variant="secondary" disabled title="Updates in der Desktop-App" class="settings__update-btn">
          Nach Updates suchen
        </QButton>
      </div>
    </section>

    <section class="settings__section">
      <template v-if="auth.isLoggedIn">
        <div class="settings__row">
          <div>
            <div class="settings__row-title">Leaderboard</div>
            <div class="settings__row-sub">
              <template v-if="leaderboard.loadingProfile">Status wird geladen …</template>
              <template v-else-if="leaderboard.profile?.participating">
                Öffentlich als {{ leaderboard.profile.nickname }}
              </template>
              <template v-else>Nicht öffentlich</template>
            </div>
          </div>
          <QButton variant="secondary" @click="router.push('/leaderboard')">
            {{ leaderboard.profile?.participating ? 'Verwalten' : 'Beitreten' }}
          </QButton>
        </div>
        <div class="settings__account-sep" />
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
        <div v-if="urlError" class="settings__url-error" role="alert">{{ urlError }}</div>
        <div class="settings__adv-actions">
          <QButton variant="ghost" :disabled="saving" @click="resetServers">Zurücksetzen auf Standard</QButton>
          <QButton :disabled="saving" @click="saveServers">{{ saved ? '✓ Übernommen' : 'Übernehmen' }}</QButton>
        </div>
      </div>
    </CollapsePanel>

    <!-- Versionen detail modal: the full info dump for one service -->
    <Teleport to="body">
      <transition name="modal-fade">
        <div
          v-if="versionDetail"
          class="vdetail q-modal-backdrop"
          role="dialog"
          aria-modal="true"
          :aria-label="versionDetailTitle"
          @click.self="versionDetail = null"
        >
          <div ref="detailCard" class="vdetail__card">
            <div class="vdetail__head">
              <div class="vdetail__title">{{ versionDetailTitle }}</div>
              <button type="button" class="q-dialog-close" aria-label="Schließen" data-autofocus @click="versionDetail = null">
                ✕
              </button>
            </div>
            <dl class="vdetail__list">
              <div v-for="row in versionDetailRows" :key="row.label" class="vdetail__row">
                <dt class="vdetail__dt">{{ row.label }}</dt>
                <dd class="vdetail__dd">
                  <a v-if="row.link" :href="row.link" target="_blank" rel="noopener noreferrer" class="vdetail__link">{{ row.value }}</a>
                  <template v-else>{{ row.value }}</template>
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </transition>
    </Teleport>
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
.settings__row--top {
  flex: none;
  flex-direction: column;
  align-items: stretch;
}
.settings__row--top > div:first-child {
  max-width: none;
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
.settings__url-error {
  font-size: 12.5px;
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  padding: 9px 12px;
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
.settings__themes {
  flex: none;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
@media (max-width: 480px) {
  .settings__themes {
    grid-template-columns: repeat(2, 1fr);
    grid-auto-rows: max-content;
  }
  .settings__theme-preview {
    height: clamp(72px, 21.5vw, 84px);
    aspect-ratio: auto;
  }
}
.settings__theme {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border: 1.5px solid var(--q-border);
  border-radius: 12px;
  background: var(--q-card);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.12s ease, transform 0.12s ease;
}
@media (hover: hover) and (pointer: fine) {
  .settings__theme:hover {
    border-color: var(--q-accent);
    transform: translateY(-1px);
  }
}
.settings__theme--on {
  border-color: var(--q-accent-strong);
  box-shadow: 0 0 0 2px var(--q-accent-ring);
}
.settings__theme:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.settings__theme-preview {
  display: flex;
  border-radius: 8px;
  padding: 8px;
  aspect-ratio: 16 / 10;
  background: var(--q-page);
}
.settings__theme-card {
  box-sizing: border-box;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-radius: 6px;
  padding: 8px;
  background: var(--q-card);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
}
.settings__theme-line {
  height: 5px;
  border-radius: 3px;
  width: 70%;
  background: var(--q-accent);
}
.settings__theme-line--mut {
  width: 45%;
  background: var(--q-accent-bg);
}
.settings__theme-action {
  position: relative;
  align-self: flex-end;
  width: 30%;
  min-width: 22px;
  height: 8px;
  border-radius: 4px;
  margin-top: auto;
  background: var(--q-accent-strong);
}
.settings__theme-action::after {
  content: '';
  position: absolute;
  inset: 3px 6px;
  border-radius: 1px;
  background: var(--q-on-accent);
  opacity: 0.85;
}
.settings__theme-name {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--q-mut);
  text-align: center;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.settings__theme--on .settings__theme-name {
  color: var(--q-ink);
}
@media (pointer: coarse) {
  .settings__theme {
    min-height: 44px;
  }
}
.settings__select-wrap {
  position: relative;
  display: inline-flex;
}
.settings__select {
  padding: 8px var(--q-control-chevron-padding-end) 8px 13px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  font-size: 12.5px;
  font-weight: 600;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
}
.settings__select-chevron {
  position: absolute;
  right: var(--q-control-chevron-inset);
  top: 50%;
  transform: translateY(-50%);
  color: var(--q-mut);
  font-size: 16px;
  pointer-events: none;
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
  font: 500 16px ui-monospace, Menlo, monospace; /* ≥16px: no iOS focus-zoom */
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
@media (pointer: coarse) {
  .settings__segment {
    min-height: 44px;
    padding: 10px 16px;
  }
  .settings__select {
    min-height: 44px;
  }
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
.settings__vlist {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  overflow: hidden;
}
.settings__vrow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
  background: var(--q-panel);
  border: none;
  width: 100%;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s ease;
}
@media (hover: hover) and (pointer: fine) {
  .settings__vrow:hover {
    background: var(--q-panel-2);
  }
}
.settings__vrow:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}
.settings__vrow + .settings__vrow {
  border-top: 1px solid var(--q-border-soft);
}
.settings__vmain {
  flex: 1;
  min-width: 0;
}
.settings__vname {
  font-size: 13px;
  font-weight: 700;
}
.settings__vsub {
  font-size: 11.5px;
  color: var(--q-mut-2);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings__vlink {
  display: inline-block;
  color: var(--q-mut-2);
  text-decoration: none;
}
@media (hover: hover) and (pointer: fine) {
  .settings__vlink:hover {
    color: var(--q-accent-strong);
    text-decoration: underline;
  }
}
.settings__vchev {
  flex: none;
  color: var(--q-faint);
  font-size: 16px;
  line-height: 1;
}
.settings__vver {
  flex: none;
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings__vver b {
  font: 700 12.5px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
.settings__vmeta {
  font: 500 10.5px ui-monospace, Menlo, monospace;
  color: var(--q-faint);
}
.settings__update-btn {
  align-self: flex-start;
}
.settings__versions-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
}

/* ---- Versionen detail modal ---- */
.vdetail {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
}
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity var(--q-transition-fast, 0.16s);
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
.vdetail__card {
  width: 100%;
  max-width: 460px;
  max-height: 82vh;
  overflow-y: auto;
  background: var(--q-card);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
}
.vdetail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 16px 16px 10px 20px;
}
.vdetail__title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.vdetail__list {
  margin: 0;
  padding: 0 20px 18px;
  display: flex;
  flex-direction: column;
}
.vdetail__row {
  display: flex;
  gap: 14px;
  padding: 7px 0;
  border-top: 1px solid var(--q-border-soft);
}
.vdetail__row:first-child {
  border-top: none;
}
.vdetail__dt {
  flex: none;
  width: 128px;
  font-size: 12px;
  color: var(--q-mut-2);
  padding-top: 1px;
}
.vdetail__dd {
  margin: 0;
  font: 500 12.5px ui-monospace, Menlo, monospace;
  color: var(--q-ink);
  word-break: break-all;
  min-width: 0;
}
.vdetail__link {
  color: var(--q-accent-strong);
}
@media (max-width: 480px) {
  .vdetail__row {
    flex-direction: column;
    gap: 2px;
  }
  .vdetail__dt {
    width: auto;
  }
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
