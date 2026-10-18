<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DesktopCleanupTarget, DesktopStorageOverview, DesktopSupportInfo } from '@qed2/core-logic';
import { QButton, QNotice } from '@qed2/ui';
import SettingsCard from './SettingsCard.vue';
import { ports } from '../../services.js';
import { useI18n } from '../../i18n.js';

const props = defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ support: [value: DesktopSupportInfo] }>();
const { t, formatNumber, formatDate } = useI18n();
const root = ref<HTMLElement | null>(null);
const storage = ports.shell.desktopStorage;
const support = ref<DesktopSupportInfo>();
const overview = ref<DesktopStorageOverview>();
const loading = ref(false);
const cleaning = ref(false);
const confirming = ref(false);
const selected = ref<DesktopCleanupTarget[]>([]);
const confirmedTargets = ref<DesktopCleanupTarget[]>([]);
const problem = ref('');
const supportProblem = ref(false);
const outcome = ref<{ freedBytes: number; incomplete: boolean; downloadActive: boolean }>();
let disposed = false;
let initializedSelection = false;

const shown = ports.shell.capabilities.desktop && Boolean(storage || ports.shell.getDesktopSupport);
const categoryLabels = {
  database: 'Lerndaten', cache: 'Zwischenspeicher', downloads: 'Downloads', logs: 'Protokolle',
};
const cleanupTargets = computed(() => (overview.value?.categories ?? [])
  .filter((item) => item.id !== 'database' && !item.blockedReason && item.cleanableBytes !== null && Number.isFinite(item.cleanableBytes) && item.cleanableBytes > 0)
  .map((item) => item.id as DesktopCleanupTarget));
const selectedTargets = computed(() => selected.value.filter((id) => cleanupTargets.value.includes(id)));
const selectedBytes = computed(() => (overview.value?.categories ?? [])
  .filter((item) => selectedTargets.value.includes(item.id as DesktopCleanupTarget))
  .reduce((total, item) => total + Math.max(0, item.cleanableBytes ?? 0), 0));
const canClean = computed(() => Boolean(storage) && selectedTargets.value.length > 0 && !problem.value && !loading.value && !cleaning.value && !props.busy);
const platformName = computed(() => {
  const value = support.value;
  if (!value) return '';
  const platform = value.platform === 'darwin' ? 'macOS' : value.platform === 'win32' ? 'Windows' : value.platform === 'linux' ? 'Linux' : t('Dieses Betriebssystem');
  const architecture = value.arch === 'arm64' ? value.platform === 'darwin' ? 'Apple Silicon' : 'ARM64' : value.arch === 'x64' ? '64-Bit' : '';
  return [platform, architecture].filter(Boolean).join(' · ');
});
const checkedAt = computed(() => {
  const date = new Date(overview.value?.measuredAt ?? '');
  return Number.isFinite(date.getTime()) ? formatDate(date, { hour: '2-digit', minute: '2-digit' }) : null;
});

function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return t('Nicht verfügbar');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${formatNumber(size, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function acceptOverview(value: DesktopStorageOverview): void {
  overview.value = value;
  selected.value = initializedSelection ? selectedTargets.value : cleanupTargets.value.slice();
  initializedSelection = true;
}

async function refresh(): Promise<void> {
  if (loading.value || cleaning.value || confirming.value) return;
  loading.value = true;
  problem.value = '';
  supportProblem.value = false;
  const jobs: Promise<void>[] = [];
  const getSupport = ports.shell.getDesktopSupport;
  if (getSupport) jobs.push(Promise.resolve().then(() => getSupport.call(ports.shell)).then((value) => {
    if (disposed) return;
    support.value = value;
    emit('support', value);
  }).catch(() => { if (!disposed) supportProblem.value = true; }));
  if (storage) jobs.push(Promise.resolve().then(() => storage.getOverview()).then((value) => {
    if (!disposed) acceptOverview(value);
  }).catch(() => {
    if (!disposed) problem.value = 'Der Speicherplatz konnte nicht ermittelt werden. Bitte erneut versuchen.';
  }));
  await Promise.all(jobs);
  if (!disposed) loading.value = false;
}

async function requestCleanup(): Promise<void> {
  if (!canClean.value) return;
  confirmedTargets.value = selectedTargets.value.slice();
  confirming.value = true;
  outcome.value = undefined;
  await nextTick();
  root.value?.querySelector<HTMLElement>('#storage-cleanup-title')?.focus();
}

async function dismissConfirmation(): Promise<void> {
  if (cleaning.value) return;
  confirming.value = false;
  await nextTick();
  root.value?.querySelector<HTMLButtonElement>('[data-storage-cleanup]')?.focus();
}

async function cleanup(): Promise<void> {
  if (!storage || !confirming.value || !canClean.value) return;
  const targets = confirmedTargets.value.filter((id) => cleanupTargets.value.includes(id));
  if (targets.length === 0) return;
  cleaning.value = true;
  problem.value = '';
  outcome.value = undefined;
  try {
    const result = await storage.cleanup(targets);
    if (disposed) return;
    acceptOverview(result.overview);
    outcome.value = {
      freedBytes: result.results.reduce((total, item) => total + (Number.isFinite(item.freedBytes) ? Math.max(0, item.freedBytes) : 0), 0),
      incomplete: result.results.some((item) => item.status !== 'cleaned'),
      downloadActive: result.results.some((item) => item.reason === 'download-active'),
    };
  } catch {
    if (!disposed) problem.value = 'Die Bereinigung konnte nicht abgeschlossen werden. Aktualisiere die Übersicht und versuche es erneut.';
  } finally {
    if (!disposed) {
      cleaning.value = false;
      confirming.value = false;
      await nextTick();
      root.value?.querySelector<HTMLButtonElement>('[data-storage-refresh]')?.focus();
    }
  }
}

onMounted(() => { if (shown) void refresh(); });
onBeforeUnmount(() => { disposed = true; });
</script>

<template>
  <div v-if="shown" ref="root" class="desktop-storage" data-desktop-storage :data-state="cleaning ? 'cleaning' : loading ? 'loading' : problem ? 'error' : overview ? 'ready' : 'unavailable'">
    <SettingsCard aria-labelledby="desktop-storage-title" class="desktop-storage__card">
      <div class="desktop-storage__head">
        <div>
          <h2 id="desktop-storage-title">{{ t('Auf diesem Gerät') }}</h2>
          <p v-if="support" class="desktop-storage__hint">{{ platformName }}</p>
        </div>
        <QButton variant="secondary" data-storage-refresh :disabled="loading || cleaning || confirming" :aria-busy="loading" @click="refresh">
          {{ loading ? t('Wird ermittelt …') : t('Übersicht aktualisieren') }}
        </QButton>
      </div>
      <p v-if="support" class="desktop-storage__hint">
        {{ support.localCoreSupported ? t('Lokale Aufgaben und Offline-Lernen werden auf diesem Gerät unterstützt.') : t('Lokale Aufgaben sind auf diesem Gerät nicht verfügbar. Du kannst die Netzwerkverbindung verwenden.') }}
      </p>
      <QNotice v-if="supportProblem" tone="error">{{ t('Die Unterstützung dieses Geräts konnte nicht geprüft werden. Bitte aktualisiere die Übersicht.') }}</QNotice>
      <p v-if="loading && !overview" role="status" class="desktop-storage__hint">{{ t('Speicherplatz wird ermittelt …') }}</p>
      <template v-if="overview">
        <div class="desktop-storage__summary">
          <div><span>{{ t('Auf dem Laufwerk verfügbar') }}</span><strong>{{ bytes(overview.disk.availableBytes) }}</strong><small>{{ t('Gesamt: {bytes}', { bytes: bytes(overview.disk.totalBytes) }) }}</small></div>
          <div><span>{{ t('Zum Freigeben ausgewählt') }}</span><strong>{{ bytes(selectedBytes) }}</strong><small v-if="checkedAt">{{ t('Stand: {time}', { time: checkedAt }) }}</small></div>
        </div>
        <fieldset class="desktop-storage__categories" :disabled="loading || cleaning || confirming">
          <legend>{{ t('Gespeicherte Dateien') }}</legend>
          <div v-for="item in overview.categories" :key="item.id" class="desktop-storage__category" :data-storage-category="item.id">
            <label v-if="item.id !== 'database'" class="desktop-storage__choice">
              <input v-model="selected" type="checkbox" :value="item.id" :disabled="!cleanupTargets.includes(item.id)" :aria-describedby="`storage-detail-${item.id}`">
              <span>{{ t(categoryLabels[item.id]) }}</span>
            </label>
            <strong v-else>{{ t(categoryLabels[item.id]) }}</strong>
            <span class="desktop-storage__bytes">{{ bytes(item.bytes) }}</span>
            <p :id="`storage-detail-${item.id}`" class="desktop-storage__detail">
              <template v-if="item.id === 'database'">{{ t('Lernfortschritt und Einstellungen bleiben erhalten.') }}</template>
              <template v-else-if="item.blockedReason === 'download-active'">{{ t('Während eines Downloads nicht verfügbar.') }}</template>
              <template v-else-if="item.blockedReason === 'unavailable' || item.cleanableBytes === null">{{ t('Derzeit nicht berechenbar. Bitte später aktualisieren.') }}</template>
              <template v-else-if="item.id === 'cache'">{{ t('Erneut ladbare Dateien · {bytes} freigebbar', { bytes: bytes(item.cleanableBytes) }) }}</template>
              <template v-else-if="item.id === 'downloads'">{{ t('Nur abgelaufene Pakete · {bytes} freigebbar', { bytes: bytes(item.cleanableBytes) }) }}</template>
              <template v-else>{{ t('Nur ältere Protokolle · {bytes} freigebbar', { bytes: bytes(item.cleanableBytes) }) }}</template>
            </p>
          </div>
        </fieldset>
        <p class="desktop-storage__hint">{{ t('Konten, Lernfortschritt, Sicherungen sowie laufende und pausierte Downloads bleiben erhalten.') }}</p>
        <p v-if="busy" class="desktop-storage__hint" role="status">{{ t('Warte mit der Bereinigung, bis der laufende Vorgang abgeschlossen ist.') }}</p>
        <QButton v-if="!confirming" variant="secondary" data-storage-cleanup :disabled="!canClean" @click="requestCleanup">{{ t('Ausgewählten Speicher freigeben') }}</QButton>
        <div v-else class="desktop-storage__confirmation" role="group" aria-labelledby="storage-cleanup-title" @keydown.esc.prevent.stop="dismissConfirmation">
          <h3 id="storage-cleanup-title" tabindex="-1">{{ t('Ausgewählte Dateien entfernen?') }}</h3>
          <p>{{ t('Es werden nur die ausgewählten, nicht mehr benötigten Dateien entfernt. Erneut benötigte Dateien werden später heruntergeladen.') }}</p>
          <p>{{ t('Auswahl: {categories}', { categories: confirmedTargets.map((id) => t(categoryLabels[id])).join(', ') }) }}</p>
          <div class="desktop-storage__actions">
            <QButton variant="secondary" :disabled="cleaning" @click="dismissConfirmation">{{ t('Abbrechen') }}</QButton>
            <QButton variant="danger" data-storage-confirm :disabled="!canClean" :aria-busy="cleaning" @click="cleanup">{{ cleaning ? t('Wird bereinigt …') : t('Dateien entfernen') }}</QButton>
          </div>
        </div>
      </template>
      <QNotice v-if="problem" tone="error">{{ t(problem) }}</QNotice>
      <p v-if="outcome" class="desktop-storage__hint" role="status">
        {{ t('{bytes} freigegeben.', { bytes: bytes(outcome.freedBytes) }) }}
        <template v-if="outcome.downloadActive"> {{ t('Ein Download ist aktiv. Seine Dateien wurden beibehalten.') }}</template>
        <template v-else-if="outcome.incomplete"> {{ t('Einige Dateien konnten nicht entfernt werden. Aktualisiere die Übersicht und versuche es später erneut.') }}</template>
      </p>
    </SettingsCard>
  </div>
</template>

<style scoped>
.desktop-storage { min-width: 0; }
.desktop-storage__card { padding: var(--q-settings-block) var(--q-settings-inset); }
.desktop-storage__card :deep(.q-settings-card__body) { gap: var(--q-space-3); }
.desktop-storage h2, .desktop-storage h3 { margin: 0; color: var(--q-ink); font-size: var(--q-font-ui); font-weight: 800; }
.desktop-storage__head, .desktop-storage__actions { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--q-space-2); flex-wrap: wrap; }
.desktop-storage__hint, .desktop-storage__detail { margin: 0; color: var(--q-mut); font-size: var(--q-font-small); line-height: 1.5; overflow-wrap: anywhere; }
.desktop-storage__summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--q-space-2); }
.desktop-storage__summary > div { display: flex; flex-direction: column; gap: var(--q-space-1); min-width: 0; padding: var(--q-space-3); background: var(--q-panel); border: 1px solid var(--q-border-soft); border-radius: var(--q-radius-control); }
.desktop-storage__summary span, .desktop-storage__summary small { color: var(--q-mut); font-size: var(--q-font-small); }
.desktop-storage__summary strong { color: var(--q-ink); font-size: var(--q-font-ui); }
.desktop-storage__categories { min-width: 0; margin: 0; padding: 0; border: 0; }
.desktop-storage__categories legend { margin-bottom: var(--q-space-2); font-size: var(--q-font-ui); font-weight: 700; }
.desktop-storage__category { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--q-space-1) var(--q-space-2); padding: var(--q-space-2) 0; border-bottom: 1px solid var(--q-border-soft); }
.desktop-storage__choice { display: flex; gap: var(--q-space-2); align-items: center; min-height: 44px; cursor: pointer; }
.desktop-storage__choice input { width: 18px; height: 18px; flex: none; accent-color: var(--q-accent); }
.desktop-storage__choice input:focus-visible { outline: 2px solid var(--q-accent); outline-offset: 3px; }
.desktop-storage__bytes { font-variant-numeric: tabular-nums; color: var(--q-mut); font-size: var(--q-font-small); }
.desktop-storage__detail { grid-column: 1 / -1; }
.desktop-storage__confirmation { padding: var(--q-space-3); border: 1px solid var(--q-border-soft); background: var(--q-panel-2); border-radius: var(--q-radius-control); }
.desktop-storage__confirmation p { color: var(--q-mut); font-size: var(--q-font-small); line-height: 1.5; }
.desktop-storage__actions { justify-content: flex-start; }
.desktop-storage :deep(button) { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 420px) { .desktop-storage__summary { grid-template-columns: 1fr; } }
</style>
