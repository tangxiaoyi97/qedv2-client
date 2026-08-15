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
import { LOCALE_ENABLED, LOCALE_LABELS, type Locale } from '../i18n.js';
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
    ...(profile.hasArchive ? ['Fortschritt'] : []),
    ...((profile.historyCount + profile.historyEventCount) > 0
      ? [`${profile.historyCount + profile.historyEventCount} Verlauf`]
      : []),
    ...(profile.attemptCount > 0 ? [`${profile.attemptCount} Antworten`] : []),
  ];
  return sections.join(' · ') || 'Unbekannte Daten';
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
    recoveryError.value = 'Export fehlgeschlagen.';
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
    recoveryError.value = 'Nicht zugeordnet. Die Daten bleiben erhalten.';
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

/* Built-in CSS extensions; external records join this list next major. */
const themeExtensionId = computed(() => app.accentTheme);
const accentSaving = ref(false);
const accentError = ref<string | undefined>();
async function pickThemeExtension(id: BuiltinThemeId): Promise<void> {
  if (accentSaving.value || id === app.accentTheme) return;
  accentSaving.value = true;
  accentError.value = undefined;
  try {
    await app.setAccentTheme(id);
  } catch {
    accentError.value = 'Das Farbschema konnte nicht sicher gespeichert werden. Die bisherige Auswahl bleibt aktiv.';
  } finally {
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
    ['Core-Adresse', form.coreBaseUrl.trim()],
    ['Server-Adresse', form.serverBaseUrl.trim()],
  ];
  for (const [label, value] of fields) {
    if (value === '') return `${label} darf nicht leer sein.`;
    try {
      canonicalServiceBaseUrl(value);
    } catch {
      return `${label}: HTTPS verwenden; HTTP nur für localhost.`;
    }
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
    });
    saved.value = true;
    setTimeout(() => (saved.value = false), 2500);
  } catch {
    urlError.value = 'Nicht gespeichert. Die bisherigen Adressen bleiben aktiv.';
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

/** Opens the full release history — every version, not just this build's. */
const changelogState = ref<'idle' | 'loading' | 'none'>('idle');
async function openChangelog(): Promise<void> {
  changelogState.value = 'loading';
  const found = await ui.showChangelogHistory();
  changelogState.value = found ? 'idle' : 'none';
  if (!found) setTimeout(() => (changelogState.value = 'idle'), 2500);
}

</script>

<template>
  <div class="settings q-page">
    <h1 class="settings__title q-page-title">Einstellungen</h1>
    <SettingsCard>
      <SettingsRow label="Aussehen">
        <template #default="{ labelId }">
          <div class="settings__segments" role="radiogroup" :aria-labelledby="labelId">
            <label
              v-for="t in THEMES"
              :key="t.value"
              class="settings__segment"
              :class="{ 'settings__segment--on': app.theme === t.value }"
            >
              <input
                class="settings__choice-input"
                type="radio"
                name="settings-appearance"
                :value="t.value"
                :checked="app.theme === t.value"
                @change="app.setTheme(t.value)"
              />
              <span>{{ t.label }}</span>
            </label>
          </div>
        </template>
      </SettingsRow>

      <SettingsRow label="Farbschema" layout="stacked">
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
                :value="extension.id"
                :checked="themeExtensionId === extension.id"
                :disabled="accentSaving"
                @change="pickThemeExtension(extension.id)"
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

      <SettingsRow :label="ui.t('settingsLanguage')">
        <template #default="{ labelId }">
          <span class="settings__select-wrap">
            <select
              class="settings__select"
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

    <SettingsCard title="Versionen">
      <template #action>
        <QButton variant="ghost" @click="app.refreshServiceInfo()" title="Dienst-Infos neu laden">
          ⟳ Aktualisieren
        </QButton>
      </template>
      <div class="settings__vlist">
        <button type="button" class="settings__vrow" @click="versionDetail = 'web'">
          <div class="settings__vname">Web-App</div>
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
          {{ changelogState === 'none' ? 'Keine Versionshinweise gefunden' : 'Änderungen' }}
        </QButton>
      </template>
    </SettingsCard>

    <AiSettings />

    <SettingsCard>
      <SettingsRow
        v-if="(recoveryInventory?.totalCount ?? 0) > 0"
        label="Lokale Daten"
        :description="`${recoveryInventory!.totalCount} nicht zugeordnet`"
      >
        <QButton variant="secondary" @click="openRecovery">Prüfen</QButton>
      </SettingsRow>
      <template v-if="auth.isLoggedIn">
        <SettingsRow label="Leaderboard">
          <template #description>
              <template v-if="leaderboard.loadingProfile">Status wird geladen …</template>
              <template v-else-if="leaderboard.profile?.participating">
                Öffentlich als {{ leaderboard.profile.nickname }}
              </template>
              <template v-else>Nicht öffentlich</template>
          </template>
          <QButton variant="secondary" @click="router.push('/leaderboard')">
            {{ leaderboard.profile?.participating ? 'Verwalten' : 'Beitreten' }}
          </QButton>
        </SettingsRow>
        <SettingsRow label="Archiv">
          <template #status>
            <div v-if="uploadStatus" class="settings__sync-status" role="status">{{ uploadStatus }}</div>
          </template>
          <QButton variant="secondary" :disabled="uploading" @click="uploadNow">
            {{ uploading ? 'Lädt hoch …' : 'Hochladen' }}
          </QButton>
        </SettingsRow>
        <SettingsRow label="Abmelden" tone="danger">
          <QButton variant="danger" @click="doLogout">Abmelden</QButton>
        </SettingsRow>
      </template>
      <template v-else>
        <SettingsRow label="Konto">
          <QButton @click="ui.openAuthModal()">Anmelden</QButton>
        </SettingsRow>
      </template>
    </SettingsCard>

    <CollapsePanel title="Erweitert · Serveradressen">
      <div class="settings__adv">
        <div class="settings__warn">
          Nur für eigene Server.
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
          Desktop-Core und Bank bleiben unverändert.
        </div>
        <div v-if="urlError" class="settings__url-error" role="alert">{{ urlError }}</div>
        <div class="settings__adv-actions">
          <QButton variant="ghost" :disabled="saving" @click="resetServers">Standard wiederherstellen</QButton>
          <QButton :disabled="saving" @click="saveServers">{{ saved ? '✓ Übernommen' : 'Übernehmen' }}</QButton>
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
          <div ref="detailCard" class="vdetail__card">
            <div class="vdetail__head">
              <div class="vdetail__title">{{ versionDetailTitle }}</div>
              <QIconButton aria-label="Schließen" data-autofocus @click="versionDetail = null" />
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
          <div ref="recoveryCard" class="recovery__card">
            <header class="recovery__head">
              <h2 id="recovery-title" class="recovery__title">Lokale Daten</h2>
              <QIconButton aria-label="Schließen" data-autofocus @click="closeRecovery" />
            </header>

            <p class="recovery__intro">Nicht automatisch zugeordnet.</p>
            <ul class="recovery__list">
              <li
                v-for="(profile, index) in recoveryInventory.profiles"
                :key="profile.profileId"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>
                    {{ profile.kind === 'unclaimed-guest' ? 'Besucherdaten' : `Datensatz ${index + 1}` }}
                  </strong>
                  <span>{{ recoveryProfileSummary(profile) }}</span>
                </div>
                <QButton
                  v-if="profile.assignment.safe && recoveryConfirm !== profile.profileId"
                  variant="secondary"
                  :disabled="recoveryBusy"
                  @click="recoveryConfirm = profile.profileId"
                >
                  Wiederherstellen
                </QButton>
                <span v-else-if="!profile.assignment.safe" class="recovery__export-only">
                  Nur Export
                </span>
                <div
                  v-if="recoveryConfirm === profile.profileId"
                  class="recovery__confirm"
                  role="group"
                  aria-label="Wiederherstellung bestätigen"
                >
                  <span>Diesem Profil zuordnen?</span>
                  <div class="recovery__confirm-actions">
                    <QButton
                      variant="ghost"
                      :disabled="recoveryBusy"
                      @click="recoveryConfirm = undefined"
                    >
                      Abbrechen
                    </QButton>
                    <QButton
                      :disabled="recoveryBusy"
                      @click="assignRecovery(profile.profileId)"
                    >
                      Zuordnen
                    </QButton>
                  </div>
                </div>
              </li>
              <li
                v-if="recoveryInventory.ambiguousAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>Offene Antworten</strong>
                  <span>{{ recoveryInventory.ambiguousAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">Nur Export</span>
              </li>
              <li
                v-if="recoveryInventory.ambiguousAccountAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>Kontodaten</strong>
                  <span>{{ recoveryInventory.ambiguousAccountAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">Nur Export</span>
              </li>
              <li
                v-if="recoveryInventory.corruptAttemptCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>Beschädigte Antworten</strong>
                  <span>{{ recoveryInventory.corruptAttemptCount }}</span>
                </div>
                <span class="recovery__export-only">Nur Export</span>
              </li>
              <li
                v-if="recoveryInventory.legacySyncMutationCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>Alte Synchronisierung</strong>
                  <span>{{ recoveryInventory.legacySyncMutationCount }}</span>
                </div>
                <span class="recovery__export-only">Nur Export</span>
              </li>
              <li
                v-if="recoveryInventory.orphanedPracticeSessionCount > 0"
                class="recovery__item"
              >
                <div class="recovery__item-copy">
                  <strong>Unterbrochene Übung</strong>
                  <span>{{ recoveryInventory.orphanedPracticeSessionCount }}</span>
                </div>
                <span class="recovery__export-only">Nur Export</span>
              </li>
            </ul>

            <p v-if="recoveryError" class="recovery__error" role="alert">
              {{ recoveryError }}
            </p>
            <footer class="recovery__footer">
              <QButton variant="secondary" :disabled="recoveryBusy" @click="downloadRecovery">
                Exportieren
              </QButton>
              <QButton variant="ghost" :disabled="recoveryBusy" @click="closeRecovery">
                Später
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
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Only the bottom gap differs from .q-page-title. */
.settings__title {
  margin-bottom: 4px;
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
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--q-control-height);
  padding: 9px 13px;
  font-size: 12px;
  font-weight: 600;
  color: var(--q-mut-2);
  background: var(--q-card);
  border: none;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
}
.settings__segment + .settings__segment {
  border-left: 1px solid var(--q-btn-border);
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
  gap: 10px;
  width: 100%;
}
@media (max-width: 480px) {
  .settings__themes {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: max-content;
  }
  .settings__theme-preview {
    height: clamp(72px, 21.5vw, 84px);
    aspect-ratio: auto;
  }
}
.settings__theme {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: var(--q-control-height);
  min-width: 0;
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
.settings__select-wrap {
  position: relative;
  display: inline-flex;
}
.settings__select {
  min-height: var(--q-control-height);
  padding: 8px var(--q-control-chevron-padding-end) 8px 13px;
  border: 1px solid var(--q-border-3);
  border-radius: 8px;
  background: var(--q-card);
  color: var(--q-ink);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
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
  font-size: 16px;
  pointer-events: none;
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
.settings__adv-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.settings__vlist {
  display: flex;
  flex-direction: column;
  margin: 0 20px 16px;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  overflow: hidden;
}
.settings__vrow {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: var(--q-control-height);
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
.settings__vname {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
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
}
.settings__vver b {
  font: 700 12.5px ui-monospace, Menlo, monospace;
  font-variant-numeric: tabular-nums;
}
/* ---- Versionen detail modal ---- */
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
.settings__sync-status {
  font-size: 12px;
  color: var(--q-mut);
  padding: 10px 14px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 8px;
}

/* ---- Explicit local recovery ---- */
.recovery__card {
  box-sizing: border-box;
  width: min(440px, calc(100vw - 24px));
  max-height: min(82vh, 680px);
  overflow-y: auto;
  background: var(--q-card);
  border: 1px solid var(--q-border);
  border-radius: 14px;
  box-shadow: var(--q-shadow-modal);
}
.recovery__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 6px 18px;
}
.recovery__title {
  margin: 0;
  color: var(--q-ink);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.01em;
}
.recovery__intro {
  margin: 0;
  padding: 0 18px 12px;
  color: var(--q-mut-2);
  font-size: 12px;
}
.recovery__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0 18px;
  list-style: none;
}
.recovery__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px 0;
  border-top: 1px solid var(--q-border-soft);
}
.recovery__item-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.recovery__item-copy strong {
  color: var(--q-ink);
  font-size: 13px;
  line-height: 1.35;
}
.recovery__item-copy span,
.recovery__export-only {
  color: var(--q-mut-2);
  font-size: 11.5px;
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
  gap: 10px;
  padding: 10px;
  color: var(--q-ink);
  font-size: 12px;
  background: var(--q-panel);
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
}
.recovery__confirm-actions,
.recovery__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.recovery__error {
  margin: 10px 18px 0;
  color: var(--q-err-ink);
  font-size: 12px;
}
.recovery__footer {
  padding: 14px 18px 18px;
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
</style>
