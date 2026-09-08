<script setup lang="ts">
/**
 * Einstellungen (prototype 4c): theme, language, advanced server addresses
 * (collapsed), version info for ALL services (web / core / server), manual
 * archive upload (supplement §9) and logout. Desktop controls use their own
 * capability-gated routes and never turn Settings into a native tool window.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  accountStorageIdentity,
  canonicalServiceBaseUrl,
  DEFAULT_CONFIG,
  type LocalProfileId,
  type LocalRecoveryInventory,
  userLocalProfileId,
} from '@qed2/core-logic';
import { ChevronDown, CollapsePanel, QButton, QIconButton, useModalA11y } from '@qed2/ui';
import AiSettings from './settings/AiSettings.vue';
import SettingsCard from './settings/SettingsCard.vue';
import SettingsRow from './settings/SettingsRow.vue';
import {
  APP_VERSION,
  attemptOutbox,
  localProfileStore,
  localRecoveryStore,
  ports,
} from '../services.js';
import { LOCALE_ENABLED, LOCALE_LABELS, useI18n, type Locale } from '../i18n.js';
import {
  BUILTIN_THEME_EXTENSIONS,
  type BuiltinThemeId,
} from '../platform/theme.js';

import { useAppStore, type ThemePref } from '../stores/app.js';
import { useAuthStore } from '../stores/auth.js';
import { useLeaderboardStore } from '../stores/leaderboard.js';
import { useProgressStore } from '../stores/progress.js';
import { useUiStore } from '../stores/ui.js';
import { databaseStatusLabel } from '../version-info.js';

const app = useAppStore();
const auth = useAuthStore();
const leaderboard = useLeaderboardStore();
const progress = useProgressStore();
const ui = useUiStore();
const router = useRouter();
const { t, formatDate } = useI18n();

/* ---- Versionen: rows are clickable, each opens a detail modal ---- */
const versionDetail = ref<'web' | 'core' | 'server' | null>(null);

onMounted(() => {
  if (auth.isLoggedIn) void leaderboard.refreshProfile();
  void refreshRecovery();
});
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) void leaderboard.refreshProfile();
    else leaderboard.clear();
    void refreshRecovery();
  },
);

/* ---- Explicit recovery of ambiguous rolling-upgrade data ---- */
const recoveryInventory = ref<LocalRecoveryInventory>();
const recoveryOpen = ref(false);
const recoveryBusy = ref(false);
const recoveryError = ref('');
const recoveryConfirm = ref<LocalProfileId>();
const recoveryCard = ref<HTMLElement | null>(null);
useModalA11y(recoveryCard, recoveryOpen, () => closeRecovery());

async function refreshRecovery(): Promise<void> {
  try {
    const target = recoveryTarget();
    recoveryInventory.value = await localRecoveryStore.inventory(target);
  } catch {
    // A malformed profile state is handled by boot's fail-closed path. Do not
    // guess a count or expose a destructive action from an incomplete read.
    recoveryInventory.value = undefined;
  }
}

function recoveryTarget(): LocalProfileId | undefined {
  const current = localProfileStore.currentIfInitialized();
  if (!current) return undefined;
  const session = auth.session;
  if (!session) return current.startsWith('guest:') ? current : undefined;
  if (!session.serverBaseUrl) return undefined;
  try {
    const ownerId = accountStorageIdentity(
      session.serverBaseUrl,
      session.user.id,
    );
    const expected = userLocalProfileId(ownerId);
    return current === expected ? current : undefined;
  } catch {
    return undefined;
  }
}

async function openRecovery(): Promise<void> {
  recoveryError.value = '';
  recoveryConfirm.value = undefined;
  await refreshRecovery();
  if ((recoveryInventory.value?.totalCount ?? 0) > 0) recoveryOpen.value = true;
}

function closeRecovery(): void {
  if (recoveryBusy.value) return;
  recoveryOpen.value = false;
  recoveryConfirm.value = undefined;
  recoveryError.value = '';
}

function recoveryProfileSummary(profile: LocalRecoveryInventory['profiles'][number]): string {
  const sections = [
    ...(profile.hasArchive ? [t('Fortschritt')] : []),
    ...((profile.historyCount + profile.historyEventCount) > 0
      ? [t('{count} Verlauf', { count: profile.historyCount + profile.historyEventCount })]
      : []),
    ...(profile.attemptCount > 0 ? [t('{count} Antworten', { count: profile.attemptCount })] : []),
  ];
  return sections.join(' · ') || t('Unbekannte Daten');
}

async function downloadRecovery(): Promise<void> {
  if (recoveryBusy.value) return;
  recoveryBusy.value = true;
  recoveryError.value = '';
  try {
    const payload = await localRecoveryStore.export(recoveryTarget());
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qed2-wiederherstellung-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch {
    recoveryError.value = t('Export fehlgeschlagen.');
  } finally {
    recoveryBusy.value = false;
  }
}

async function assignRecovery(profileId: LocalProfileId): Promise<void> {
  const target = recoveryTarget();
  if (!target || recoveryBusy.value) return;
  recoveryBusy.value = true;
  recoveryError.value = '';
  let syncRecoveredAccount = false;
  try {
    await refreshRecovery();
    const candidate = recoveryInventory.value?.profiles.find(
      (profile) => profile.profileId === profileId,
    );
    if (!candidate?.assignment.safe) throw new Error('Recovery assignment is no longer safe');
    if (recoveryTarget() !== target) throw new Error('Recovery account changed');
    const session = auth.session;
    const scopedOwnerId = target.startsWith('user:') ? target.slice('user:'.length) : undefined;
    const pendingLegacyRecovery = await attemptOutbox.pendingLegacyAccountRecovery();
    const pending = pendingLegacyRecovery
      ? {
          sourceGeneration: pendingLegacyRecovery.sourceGeneration,
          destinationUserId: pendingLegacyRecovery.scopedUserId,
        }
      : await attemptOutbox.pendingGuestClaimRoute();
    if (pending && (!session?.serverBaseUrl || !scopedOwnerId)) {
      throw new Error('Pending account recovery requires a verified account');
    }
    if (
      session?.serverBaseUrl
      && scopedOwnerId
      && accountStorageIdentity(session.serverBaseUrl, session.user.id) !== scopedOwnerId
    ) throw new Error('Recovery account changed');
    if (candidate.kind === 'unclaimed-guest') {
      if (!target.startsWith('user:')) throw new Error('Guest recovery requires an account');
      if (!scopedOwnerId) throw new Error('Verified account identity is missing');
      // Any pending marker already rotated the attempt generation. It belongs
      // to the pre-rotation guest, never to this fresh unclaimed profile.
      if (pending) throw new Error('Resolve the interrupted account claim first');
      await progress.claimGuestAttempts(scopedOwnerId, candidate.profileId);
      syncRecoveredAccount = true;
    } else if (pending) {
      if (!session?.serverBaseUrl || !scopedOwnerId) {
        throw new Error('Verified account issuer is missing');
      }
      if (
        pending.destinationUserId !== scopedOwnerId
        && pending.destinationUserId !== session.user.id
      ) throw new Error('Guest recovery belongs to another account');
      if (
        pendingLegacyRecovery
        && (pendingLegacyRecovery.sourceProfileId !== profileId
          || pendingLegacyRecovery.legacyUserId !== session.user.id
          || pendingLegacyRecovery.scopedUserId !== scopedOwnerId)
      ) throw new Error('Guest recovery is bound to another Server');
      await localRecoveryStore.assignLegacyPendingAccount(profileId, target, {
        legacyUserId: pendingLegacyRecovery?.legacyUserId ?? session.user.id,
        scopedUserId: pendingLegacyRecovery?.scopedUserId ?? scopedOwnerId,
        sourceGeneration: pending.sourceGeneration,
      });
      syncRecoveredAccount = true;
    } else {
      await localRecoveryStore.assign(profileId, target);
      syncRecoveredAccount = target.startsWith('user:');
    }
    await localProfileStore.refresh();
    await progress.refresh();
    // Ownership and the recovered archive are durable before cloud work. A
    // dead connection therefore leaves the outbox/archive pending normally.
    if (syncRecoveredAccount) {
      await progress.flushAttemptOutbox().catch(() => undefined);
      await progress.syncNow({ quiet: true }).catch(() => undefined);
    }
    recoveryConfirm.value = undefined;
    await refreshRecovery();
    if ((recoveryInventory.value?.totalCount ?? 0) === 0) recoveryOpen.value = false;
  } catch {
    recoveryError.value = t('Nicht zugeordnet. Die Daten bleiben erhalten.');
    await refreshRecovery();
  } finally {
    recoveryBusy.value = false;
  }
}

interface DetailRow {
  label: string;
  value: string;
  link?: string;
}
const versionDetailRows = computed<DetailRow[]>(() => {
  if (versionDetail.value === 'web') {
    return [
      { label: t('Dienst'), value: 'qed2-client (Web-App)' },
      { label: t('Version'), value: APP_VERSION },
      { label: 'Commit', value: ui.appCommit },
      { label: 'Repository', value: 'github.com/tangxiaoyi97/qedv2-client', link: 'https://github.com/tangxiaoyi97/qedv2-client' },
    ];
  }
  if (versionDetail.value === 'core') {
    const i = app.coreInfo;
    if (!i) return [{ label: t('Status'), value: t('nicht erreichbar') }];
    return [
      { label: t('Dienst'), value: i.service },
      { label: t('Version'), value: i.version },
      { label: t('Core-Commit'), value: i.commit ?? t('unbekannt') },
      { label: t('Core-Repository'), value: i.sourceRepo.replace('https://github.com/', 'github.com/'), link: i.sourceRepo },
      { label: 'Build', value: formatBuildTime(i.buildTime) },
      { label: t('Unterstützte Bank-Schemas'), value: `${i.schemaVersionSupported.min} – ${i.schemaVersionSupported.max}` },
      { label: t('Bank-Commit'), value: i.bank.commit ?? t('unbekannt') },
      { label: t('Bank-Repository'), value: i.bank.repo.replace('https://github.com/', 'github.com/'), link: i.bank.repo },
      { label: t('Bank-Branch'), value: i.bank.branch },
      { label: t('Aufgaben'), value: t('{total} insgesamt · {available} verfügbar', { total: i.bank.questionCount, available: i.bank.playableCount }) },
    ];
  }
  if (versionDetail.value === 'server') {
    const i = app.serverInfo;
    if (!i) return [{ label: t('Status'), value: t('nicht erreichbar') }];
    return [
      { label: t('Dienst'), value: i.service },
      { label: t('Version'), value: i.version },
      { label: t('Server-Commit'), value: i.commit ?? t('unbekannt') },
      { label: t('Server-Repository'), value: i.sourceRepo.replace('https://github.com/', 'github.com/'), link: i.sourceRepo },
      { label: 'Build', value: formatBuildTime(i.buildTime) },
      { label: t('Datenbank-Status'), value: t(databaseStatusLabel(i.database?.status)) },
      { label: t('Datenbank-System'), value: 'PostgreSQL' },
      { label: t('Schema-Version'), value: i.database?.schemaVersion == null ? t('unbekannt') : `Schema ${i.database.schemaVersion}` },
      { label: t('Letzte Migration'), value: i.database?.latestMigration ?? t('unbekannt') },
      { label: 'Auth', value: i.auth },
    ];
  }
  return [];
});
const versionDetailTitle = computed(() =>
  versionDetail.value === 'web' ? t('Web-App') : versionDetail.value === 'core' ? 'Core' : 'Server',
);

const detailCard = ref<HTMLElement | null>(null);
useModalA11y(detailCard, computed(() => versionDetail.value !== null), () => (versionDetail.value = null));

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
  { value: 'system', label: 'System' },
];
const LOCALES: Locale[] = ['de', 'en'];
const themeSaving = ref(false);
const themeError = ref('');
const themeDraft = ref<ThemePref>();
const themeChoice = computed({
  get: () => themeDraft.value ?? app.theme,
  set: (value: ThemePref) => { void pickTheme(value); },
});
async function pickTheme(theme: ThemePref): Promise<void> {
  if (themeSaving.value || theme === app.theme) return;
  themeDraft.value = theme;
  themeSaving.value = true;
  themeError.value = '';
  try {
    await app.setTheme(theme);
  } catch {
    themeError.value = t('Aussehen konnte nicht gespeichert werden.');
  } finally {
    themeDraft.value = undefined;
    themeSaving.value = false;
  }
}

/* Built-in CSS extensions; external records join this list next major. */
const accentDraft = ref<BuiltinThemeId>();
const themeExtensionId = computed({
  get: () => accentDraft.value ?? app.accentTheme,
  set: (value: BuiltinThemeId) => { void pickThemeExtension(value); },
});
const accentSaving = ref(false);
const accentError = ref<string | undefined>();
async function pickThemeExtension(id: BuiltinThemeId): Promise<void> {
  if (accentSaving.value || id === app.accentTheme) return;
  accentDraft.value = id;
  accentSaving.value = true;
  accentError.value = undefined;
  try {
    await app.setAccentTheme(id);
  } catch {
    accentError.value = t('Das Farbschema konnte nicht sicher gespeichert werden. Die bisherige Auswahl bleibt aktiv.');
  } finally {
    accentDraft.value = undefined;
    accentSaving.value = false;
  }
}

function onLocaleChange(ev: Event): void {
  ui.setLocale((ev.target as HTMLSelectElement).value as Locale);
}

const form = reactive({
  coreBaseUrl: app.config.coreBaseUrl,
  serverBaseUrl: app.config.serverBaseUrl,
});
watch(
  () => app.config,
  (c) => {
    form.coreBaseUrl = c.coreBaseUrl;
    form.serverBaseUrl = c.serverBaseUrl;
  },
);

const saved = ref(false);
const saving = ref(false);
const urlError = ref('');

/** Only absolute http(s) URLs are meaningful server addresses — catch typos
 *  (missing scheme, stray spaces) before they wedge the whole app. */
function validateUrls(): string {
  const fields: [string, string][] = [
    [t('Core-Adresse'), form.coreBaseUrl.trim()],
    [t('Server-Adresse'), form.serverBaseUrl.trim()],
  ];
  for (const [label, value] of fields) {
    if (value === '') return t('{label} darf nicht leer sein.', { label });
    try {
      canonicalServiceBaseUrl(value);
    } catch {
      return t('{label}: HTTPS verwenden; HTTP nur für localhost.', { label });
    }
  }
  return '';
}

async function saveServers(): Promise<void> {
  if (saving.value) return;
  urlError.value = validateUrls();
  if (urlError.value) return;
  saving.value = true;
  try {
    await app.updateConfig({
      coreBaseUrl: form.coreBaseUrl.trim(),
      serverBaseUrl: form.serverBaseUrl.trim(),
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch {
    urlError.value = t('Nicht gespeichert. Die bisherigen Adressen bleiben aktiv.');
  } finally {
    saving.value = false;
  }
}

async function resetServers(): Promise<void> {
  form.coreBaseUrl = DEFAULT_CONFIG.coreBaseUrl;
  form.serverBaseUrl = DEFAULT_CONFIG.serverBaseUrl;
  await saveServers();
}

/** de-AT build stamp, e.g. „04.07.2026, 14:30". */
function formatBuildTime(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? t('unbekannt') : formatDate(value, { dateStyle: 'medium', timeStyle: 'short' });
}

/* manual archive upload (supplement §9) */
const uploading = ref(false);
const uploadTried = ref(false);
const uploadError = ref('');

async function uploadNow(): Promise<void> {
  if (uploading.value) return;
  uploading.value = true;
  uploadTried.value = true;
  uploadError.value = '';
  try {
    await progress.syncCloudNow();
  } catch {
    uploadError.value = t('Synchronisierung fehlgeschlagen. Erneut versuchen.');
  } finally {
    uploading.value = false;
  }
}

const uploadStatus = computed(() => {
  if (!uploadTried.value) return '';
  if (uploading.value) return t('Wird synchronisiert …');
  if (uploadError.value) return uploadError.value;
  if (progress.archiveChoice) return t('Bitte Archiv auswählen.');
  const s = progress.syncStatus;
  switch (s.state) {
    case 'syncing':
      return t('⟳ Wird hochgeladen …');
    case 'synced':
      if (progress.attemptUploadStatus.pendingCount > 0) {
        return progress.attemptUploadStatus.state === 'error'
          ? t(progress.attemptUploadStatus.message ?? 'Antwortverlauf nicht synchronisiert.')
          : t('{count} Antworten warten auf Upload.', { count: progress.attemptUploadStatus.pendingCount });
      }
      return t('✓ Synchronisiert {time}', { time: s.at ? formatDate(s.at, { hour: '2-digit', minute: '2-digit' }) : '' }).trim();
    case 'conflict':
      return t('⚠ Konflikt — der Dialog öffnet sich');
    case 'offline':
      return t('Lokal gespeichert · Upload wird wiederholt.');
    case 'error':
      return t('Fehler: {message}', { message: s.message ? t(s.message) : t('unbekannt') });
    default:
      return '';
  }
});

const loggingOut = ref(false);
const logoutError = ref('');
async function doLogout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = '';
  try {
    await auth.logout();
  } catch {
    logoutError.value = t('Abmelden fehlgeschlagen. Erneut versuchen.');
  } finally {
    loggingOut.value = false;
  }
}

/** Opens the full release history — every version, not just this build's. */
const changelogState = ref<'idle' | 'loading' | 'none'>('idle');
async function openChangelog(): Promise<void> {
  if (changelogState.value === 'loading') return;
  changelogState.value = 'loading';
  const found = await ui.showChangelogHistory();
  changelogState.value = found ? 'idle' : 'none';
  if (!found) setTimeout(() => (changelogState.value = 'idle'), 2500);
}

</script>

<template>
  <div class="settings q-page q-settings-panel">
    <h1 class="settings__title q-page-title">{{ t('Einstellungen') }}</h1>
    <SettingsCard>
      <SettingsRow class="settings__appearance-row" :label="t('Aussehen')">
        <template #status>
          <span v-if="themeError" class="settings__url-error" role="alert">{{ themeError }}</span>
        </template>
        <template #default="{ labelId }">
          <div class="settings__segments q-settings-segments" role="radiogroup" :aria-labelledby="labelId" :aria-busy="themeSaving">
            <label
              v-for="theme in THEMES"
              :key="theme.value"
              class="settings__segment q-settings-segment"
              :class="{ 'settings__segment--on': themeChoice === theme.value }"
            >
              <input
                class="settings__choice-input"
                type="radio"
                name="settings-appearance"
                v-model="themeChoice"
                :value="theme.value"
                :disabled="themeSaving"
              />
              <span>{{ t(theme.label) }}</span>
            </label>
          </div>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('Farbschema')" layout="stacked">
        <template #status>
          <div v-if="accentError" class="settings__url-error" role="alert">{{ accentError }}</div>
        </template>
        <template #default="{ labelId }">
          <div class="settings__themes" role="radiogroup" :aria-labelledby="labelId">
            <label
              v-for="extension in BUILTIN_THEME_EXTENSIONS"
              :key="extension.id"
              class="settings__theme"
              :class="{
                'settings__theme--on': themeExtensionId === extension.id,
                'settings__theme--disabled': accentSaving,
              }"
              :data-accent="extension.id"
              :aria-busy="accentSaving || undefined"
              :title="extension.label"
            >
              <input
                class="settings__choice-input"
                type="radio"
                name="settings-colour-scheme"
                v-model="themeExtensionId"
                :value="extension.id"
                :disabled="accentSaving"
              />
              <span class="settings__theme-preview" aria-hidden="true">
                <span class="settings__theme-card">
                  <span class="settings__theme-line" />
                  <span class="settings__theme-line settings__theme-line--mut" />
                  <span class="settings__theme-action" />
                </span>
              </span>
              <span class="settings__theme-name">{{ extension.label }}</span>
            </label>
          </div>
        </template>
      </SettingsRow>

      <SettingsRow :label="t('Sprache')">
        <template #default="{ labelId }">
          <span class="settings__select-wrap">
            <select
              class="settings__select q-settings-field"
              :aria-labelledby="labelId"
              :value="ui.locale"
              @change="onLocaleChange"
            >
              <option v-for="locale in LOCALES" :key="locale" :value="locale" :disabled="!LOCALE_ENABLED[locale]">
                {{ LOCALE_LABELS[locale] }}
              </option>
            </select>
            <ChevronDown class="settings__select-chevron" />
          </span>
        </template>
      </SettingsRow>
    </SettingsCard>

    <AiSettings />

    <SettingsCard>
      <SettingsRow
        v-if="(recoveryInventory?.totalCount ?? 0) > 0"
        :label="t('Lokale Daten')"
        :description="t('{count} nicht zugeordnet', { count: recoveryInventory!.totalCount })"
      >
        <QButton variant="secondary" @click="openRecovery">{{ t('Prüfen') }}</QButton>
      </SettingsRow>
      <template v-if="auth.isLoggedIn">
        <SettingsRow label="Leaderboard">
          <template #description>
              <template v-if="leaderboard.loadingProfile">{{ t('Status wird geladen …') }}</template>
              <template v-else-if="leaderboard.profile?.participating">
                {{ t('Öffentlich als {name}', { name: leaderboard.profile.nickname }) }}
              </template>
              <template v-else>{{ t('Nicht öffentlich') }}</template>
          </template>
          <QButton variant="secondary" @click="router.push('/leaderboard')">
            {{ leaderboard.profile?.participating ? t('Verwalten') : t('Beitreten') }}
          </QButton>
        </SettingsRow>
        <SettingsRow :label="t('Archiv')">
          <template #status>
            <div v-if="uploadStatus" class="settings__sync-status" role="status">{{ uploadStatus }}</div>
          </template>
          <QButton variant="secondary" :loading="uploading" @click="uploadNow">
            {{ t('Synchronisieren') }}
          </QButton>
        </SettingsRow>
        <SettingsRow :label="t('Abmelden')" tone="danger">
          <template #status>
            <span v-if="logoutError" role="alert">{{ logoutError }}</span>
          </template>
          <QButton variant="danger" :disabled="loggingOut" :aria-busy="loggingOut" @click="doLogout">{{ loggingOut ? t('Wird abgemeldet …') : t('Abmelden') }}</QButton>
        </SettingsRow>
      </template>
      <template v-else>
        <SettingsRow :label="t('Konto')">
          <QButton @click="ui.openAuthModal()">{{ t('Anmelden') }}</QButton>
        </SettingsRow>
      </template>
    </SettingsCard>

    <SettingsCard :title="t('Versionen')">
      <template #action>
        <QButton variant="ghost" @click="app.refreshServiceInfo()" :title="t('Dienst-Infos neu laden')">
          {{ t('⟳ Aktualisieren') }}
        </QButton>
      </template>
      <div class="settings__vlist">
        <button type="button" class="settings__vrow" @click="versionDetail = 'web'">
          <div class="settings__vname">{{ t('Web-App') }}</div>
          <div class="settings__vver">
            <b>{{ APP_VERSION }}</b>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
        <button type="button" class="settings__vrow" @click="versionDetail = 'core'">
          <div class="settings__vname">Core</div>
          <div class="settings__vver">
            <b>{{ app.coreInfo?.version ?? '—' }}</b>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
        <button type="button" class="settings__vrow" @click="versionDetail = 'server'">
          <div class="settings__vname">Server</div>
          <div class="settings__vver">
            <b>{{ app.serverInfo?.version ?? '—' }}</b>
          </div>
          <span class="settings__vchev" aria-hidden="true">›</span>
        </button>
      </div>
      <template #footer>
        <QButton variant="secondary" :disabled="changelogState === 'loading'" @click="openChangelog">
          {{ changelogState === 'none' ? t('Keine Versionshinweise gefunden') : t('Änderungen') }}
        </QButton>
      </template>
    </SettingsCard>

    <CollapsePanel :title="t('Serveradressen')">
      <div class="settings__adv">
        <label class="settings__field">
          <span class="settings__label">{{ t('Inhalts-Server (core)') }}</span>
          <input v-model="form.coreBaseUrl" type="url" inputmode="url" autocomplete="url" autocapitalize="off" class="settings__input q-settings-field" spellcheck="false" :disabled="saving" @input="saved = false" />
        </label>
        <label class="settings__field">
          <span class="settings__label">{{ t('Nutzer-Server (sync)') }}</span>
          <input v-model="form.serverBaseUrl" type="url" inputmode="url" autocomplete="url" autocapitalize="off" class="settings__input q-settings-field" spellcheck="false" :disabled="saving" @input="saved = false" />
        </label>
        <div v-if="urlError" class="settings__url-error" role="alert">{{ urlError }}</div>
        <div class="settings__adv-actions">
          <QButton variant="ghost" :disabled="saving" @click="resetServers">{{ t('Standard wiederherstellen') }}</QButton>
          <QButton :disabled="saving" :aria-busy="saving" @click="saveServers">{{ saving ? t('Wird gespeichert …') : saved ? t('✓ Übernommen') : t('Übernehmen') }}</QButton>
        </div>
      </div>
    </CollapsePanel>

    <!-- Versionen detail modal: the full info dump for one service -->
    <Teleport to="body">
      <transition name="modal-fade">
        <div
          v-if="versionDetail"
          class="vdetail q-modal-scrim q-modal-backdrop"
          role="dialog"
          aria-modal="true"
          :aria-label="versionDetailTitle"
          @click.self="versionDetail = null"
        >
          <div ref="detailCard" class="vdetail__card q-settings-panel">
            <div class="vdetail__head">
              <div class="vdetail__title">{{ versionDetailTitle }}</div>
              <QIconButton :aria-label="t('Schließen')" data-autofocus @click="versionDetail = null" />
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

    <Teleport to="body">
      <transition name="modal-fade">
        <div
          v-if="recoveryOpen && recoveryInventory"
          class="recovery q-modal-scrim q-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recovery-title"
          @click.self="closeRecovery"
        >
          <div ref="recoveryCard" class="recovery__card q-settings-panel">
            <header class="recovery__head">
              <h2 id="recovery-title" class="recovery__title">{{ t('Lokale Daten') }}</h2>
              <QIconButton :aria-label="t('Schließen')" data-autofocus @click="closeRecovery" />
            </header>

            <p class="recovery__intro">{{ t('Nicht automatisch zugeordnet.') }}</p>
            <ul class="recovery__list">
              <li
                v-for="(profile, index) in recoveryInventory.profiles"
                :key="profile.profileId"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>
                    {{ profile.kind === 'unclaimed-guest' ? t('Besucherdaten') : t('Datensatz {number}', { number: index + 1 }) }}
                  </strong>
                  <span>{{ recoveryProfileSummary(profile) }}</span>
                </div>
                <QButton
                  v-if="profile.assignment.safe && recoveryConfirm !== profile.profileId"
                  variant="secondary"
                  :disabled="recoveryBusy"
                  @click="recoveryConfirm = profile.profileId"
                >
                  {{ t('Wiederherstellen') }}
                </QButton>
                <span v-else-if="!profile.assignment.safe" class="recovery__export-only">
                  {{ t('Nur Export') }}
                </span>
                <div
                  v-if="recoveryConfirm === profile.profileId"
                  class="recovery__confirm"
                  role="group"
                  :aria-label="t('Wiederherstellung bestätigen')"
                >
                  <span>{{ t('Diesem Profil zuordnen?') }}</span>
                  <div class="recovery__confirm-actions">
                    <QButton
                      variant="ghost"
                      :disabled="recoveryBusy"
                      @click="recoveryConfirm = undefined"
                    >
                      {{ t('Abbrechen') }}
                    </QButton>
                    <QButton
                      :disabled="recoveryBusy"
                      @click="assignRecovery(profile.profileId)"
                    >
                      {{ t('Zuordnen') }}
                    </QButton>
                  </div>
                </div>
              </li>
              <li
                v-if="recoveryInventory.ambiguousAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>{{ t('Offene Antworten') }}</strong>
                  <span>{{ recoveryInventory.ambiguousAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">{{ t('Nur Export') }}</span>
              </li>
              <li
                v-if="recoveryInventory.ambiguousAccountAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>{{ t('Kontodaten') }}</strong>
                  <span>{{ recoveryInventory.ambiguousAccountAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">{{ t('Nur Export') }}</span>
              </li>
              <li
                v-if="recoveryInventory.corruptAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>{{ t('Beschädigte Antworten') }}</strong>
                  <span>{{ recoveryInventory.corruptAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">{{ t('Nur Export') }}</span>
              </li>
              <li
                v-if="recoveryInventory.legacySyncMutationCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>{{ t('Alte Synchronisierung') }}</strong>
                  <span>{{ recoveryInventory.legacySyncMutationCount }}</span>
                </div>
                <span class="recovery__export-only">{{ t('Nur Export') }}</span>
              </li>
              <li
                v-if="recoveryInventory.orphanedPracticeSessionCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>{{ t('Unterbrochene Übung') }}</strong>
                  <span>{{ recoveryInventory.orphanedPracticeSessionCount }}</span>
                </div>
                <span class="recovery__export-only">{{ t('Nur Export') }}</span>
              </li>
            </ul>

            <p v-if="recoveryError" class="recovery__error" role="alert">
              {{ recoveryError }}
            </p>
            <footer class="recovery__footer">
              <QButton variant="secondary" :disabled="recoveryBusy" @click="downloadRecovery">
                {{ t('Exportieren') }}
              </QButton>
              <QButton variant="ghost" :disabled="recoveryBusy" @click="closeRecovery">
                {{ t('Später') }}
              </QButton>
            </footer>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<style scoped>
.settings {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: var(--q-space-4);
}
/* Only the bottom gap differs from .q-page-title. */
.settings__title {
  margin-bottom: var(--q-space-1);
}
.settings__url-error {
  font-size: var(--q-font-small);
  color: var(--q-err-ink);
  background: var(--q-err-bg);
  border: 1px solid var(--q-err-border);
  border-radius: var(--q-radius-control);
  padding: var(--q-space-3);
}
.settings__segment--on {
  background: var(--q-accent-strong);
  color: var(--q-on-accent);
  font-weight: 700;
}
.settings__segment:focus-within {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--q-accent);
  outline-offset: -2px;
}
.settings__choice-input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}
.settings__themes {
  flex: none;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--q-space-3);
  width: 100%;
}
@media (max-width: 480px) {
  .settings__themes {
    gap: var(--q-space-2);
  }
  .settings .settings__theme-preview {
    height: 28px;
    aspect-ratio: auto;
    background: var(--q-accent-strong);
  }
  .settings .settings__theme-card {
    display: none;
  }
}
.settings__theme {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: var(--q-control-height);
  min-width: 0;
  gap: var(--q-space-2);
  padding: var(--q-space-1);
  border: 1.5px solid var(--q-border);
  border-radius: var(--q-radius-card);
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
.settings__theme:focus-within {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.settings__theme--disabled {
  cursor: wait;
  opacity: 0.65;
}
.settings__theme-preview {
  box-sizing: border-box;
  display: flex;
  width: 100%;
  border-radius: var(--q-radius-control);
  padding: var(--q-space-2);
  aspect-ratio: 16 / 10;
  background: var(--q-page);
}
.settings__theme-card {
  box-sizing: border-box;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--q-space-1);
  border-radius: 6px;
  padding: var(--q-space-2);
  background: var(--q-card);
  box-shadow: var(--q-shadow-card);
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
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--q-font-small);
  font-weight: 700;
  color: var(--q-mut);
  text-align: center;
  text-transform: lowercase;
  letter-spacing: 0.02em;
}
.settings__theme--on .settings__theme-name {
  color: var(--q-ink);
}
.settings__select-wrap {
  position: relative;
  display: inline-flex;
}
.settings__select {
  width: auto;
  padding-right: var(--q-control-chevron-padding-end);
  appearance: none;
}
.settings__select:focus-visible {
  outline: 2px solid var(--q-accent);
  outline-offset: 2px;
}
.settings__select-chevron {
  position: absolute;
  right: var(--q-control-chevron-inset);
  top: 50%;
  transform: translateY(-50%);
  color: var(--q-mut);
  font-size: var(--q-font-input);
  pointer-events: none;
}
.settings__adv {
  display: flex;
  flex-direction: column;
  gap: var(--q-space-3);
}
.settings__field {
  display: flex;
  flex-direction: column;
  gap: var(--q-space-1);
}
.settings__label {
  font-size: var(--q-font-ui);
  font-weight: 600;
  color: var(--q-mut);
  line-height: 1.4;
}
.settings__adv-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--q-space-2);
  flex-wrap: wrap;
  margin-top: var(--q-space-2);
}
.settings__vlist {
  display: flex;
  flex-direction: column;
  margin: 0;
  border-top: 1px solid var(--q-border-soft);
}
.settings__vrow {
  display: flex;
  align-items: center;
  gap: var(--q-space-3);
  min-height: var(--q-control-height);
  padding: var(--q-settings-block) var(--q-settings-inset);
  background: var(--q-card);
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
.settings__vname {
  flex: 1;
  min-width: 0;
  font-size: var(--q-font-ui);
  font-weight: 700;
}
.settings__vchev {
  flex: none;
  color: var(--q-faint);
  font-size: var(--q-font-input);
  line-height: 1;
}
.settings__vver {
  flex: none;
  text-align: right;
}
.settings__vver b {
  font: 600 var(--q-font-small)/1.5 ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
/* ---- Versionen detail modal ---- */
.vdetail__card {
  width: 100%;
  max-width: 460px;
  max-height: 82vh;
  overflow-y: auto;
  background: var(--q-card);
  border-radius: var(--q-radius-dialog);
  box-shadow: var(--q-shadow-modal);
}
.vdetail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--q-space-3);
  padding: var(--q-settings-block) var(--q-settings-inset);
}
.vdetail__title {
  font-size: var(--q-font-ui);
  font-weight: 800;
  letter-spacing: -0.01em;
}
.vdetail__list {
  margin: 0;
  padding: 0 var(--q-settings-inset) var(--q-settings-block);
  display: flex;
  flex-direction: column;
}
.vdetail__row {
  display: flex;
  gap: var(--q-space-3);
  padding: var(--q-space-2) 0;
  border-top: 1px solid var(--q-border-soft);
}
.vdetail__row:first-child {
  border-top: none;
}
.vdetail__dt {
  flex: none;
  width: 128px;
  font-size: var(--q-font-small);
  color: var(--q-mut-2);
  padding-top: 1px;
}
.vdetail__dd {
  margin: 0;
  font: 500 var(--q-font-small)/1.5 ui-monospace, Menlo, monospace;
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
    gap: var(--q-space-1);
  }
  .vdetail__dt {
    width: auto;
  }
}
.settings__sync-status {
  font-size: var(--q-font-small);
  color: var(--q-mut);
  padding: var(--q-space-3);
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control);
}

/* ---- Explicit local recovery ---- */
.recovery__card {
  box-sizing: border-box;
  width: min(440px, calc(100vw - 24px));
  max-height: min(82vh, 680px);
  overflow-y: auto;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: var(--q-radius-dialog);
  box-shadow: var(--q-shadow-modal);
}
.recovery__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--q-space-3);
  padding: var(--q-settings-block) var(--q-settings-inset);
}
.recovery__title {
  margin: 0;
  color: var(--q-ink);
  font-size: var(--q-font-ui);
  font-weight: 800;
  letter-spacing: -0.01em;
}
.recovery__intro {
  margin: 0;
  padding: 0 var(--q-settings-inset) var(--q-settings-block);
  color: var(--q-mut-2);
  font-size: var(--q-font-small);
}
.recovery__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0 var(--q-settings-inset);
  list-style: none;
}
.recovery__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--q-space-3);
  min-width: 0;
  padding: var(--q-space-3) 0;
  border-top: 1px solid var(--q-border-soft);
}
.recovery__item-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--q-space-1);
}
.recovery__item-copy strong {
  color: var(--q-ink);
  font-size: var(--q-font-ui);
  line-height: 1.4;
}
.recovery__item-copy span,
.recovery__export-only {
  color: var(--q-mut-2);
  font-size: var(--q-font-small);
  line-height: 1.4;
}
.recovery__export-only {
  white-space: nowrap;
}
.recovery__confirm {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--q-space-3);
  padding: var(--q-space-3);
  color: var(--q-ink);
  font-size: var(--q-font-small);
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control);
}
.recovery__confirm-actions,
.recovery__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--q-space-2);
  flex-wrap: wrap;
}
.recovery__error {
  margin: var(--q-settings-block) var(--q-settings-inset) 0;
  color: var(--q-err-ink);
  font-size: var(--q-font-small);
}
.recovery__footer {
  padding: var(--q-settings-block) var(--q-settings-inset);
}
@media (max-width: 360px) {
  .recovery__item,
  .recovery__confirm {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }
  .recovery__confirm {
    display: grid;
  }
  .recovery__item > :deep(button),
  .recovery__confirm-actions,
  .recovery__footer {
    width: 100%;
  }
  .recovery__confirm-actions > :deep(button),
  .recovery__footer > :deep(button) {
    flex: 1 1 auto;
  }
}
@media (max-width: 420px) {
  .settings__appearance-row { grid-template-columns: minmax(0, 1fr); }
  .settings__appearance-row :deep(.q-settings-row__control) { justify-self: stretch; }
  .settings__segments { width: 100%; }
}
</style>
