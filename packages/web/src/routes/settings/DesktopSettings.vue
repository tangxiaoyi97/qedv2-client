<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  type CoreRecoveryAction,
  type CoreSourcePreference,
  type DesktopWindowTarget,
  type OperationProgress,
  type UpdateCheckResult,
  type UpdateSnapshot,
  type UpdateTargetState,
} from '@qed2/core-logic';
import { QButton, QNotice, CollapsePanel } from '@qed2/ui';
import { Cloud, HardDrive, LoaderCircle } from 'lucide-vue-next';
import { useI18n } from '../../i18n.js';
import SettingsCard from './SettingsCard.vue';
import { ports } from '../../services.js';
import { useAppStore } from '../../stores/app.js';
import { shortCommit } from '../../version-info.js';

type DesktopPanel = 'overview' | 'updates' | 'node';

interface ProgressView {
  determinate: boolean;
  value: number;
  max: number;
  label: string;
}

interface TargetView {
  state: UpdateTargetState;
  label: string;
  phaseLabel: string;
  progress: ProgressView | null;
}

const UPDATE_TARGETS = ['app', 'core', 'bank'] as const;
const SETTLED_CHECK_PHASES = new Set<UpdateTargetState['phase']>([
  'available',
  'complete',
  'restart-required',
]);

const props = defineProps<{
  panel?: DesktopPanel;
}>();
const route = useRoute();
const app = useAppStore();
const { t, formatNumber } = useI18n();
const root = ref<HTMLElement | null>(null);
const toolHeading = ref<HTMLElement | null>(null);
const busyAction = ref<
  CoreRecoveryAction | `source-${CoreSourcePreference}` | 'check' | 'apply' | 'relaunch' | null
>(null);
const problem = ref('');
const snapshotProblem = ref('');
const notice = ref('');
const updateSnapshot = ref<UpdateSnapshot>();
const snapshotLoading = ref(false);
const openingWindow = ref<DesktopWindowTarget | null>(null);
let stopUpdateSubscription: (() => void) | undefined;

const isDesktopShell = ports.shell.capabilities.desktop;
const activePanel = computed<DesktopPanel>(() => {
  if (props.panel) return props.panel;
  if (route.path === '/desktop/updates' || route.query.desktopWindow === 'updates') return 'updates';
  if (route.path === '/desktop/node' || route.query.desktopWindow === 'node') return 'node';
  return 'overview';
});
const isToolWindow = computed(() => activePanel.value !== 'overview');
const showRuntime = computed(() => activePanel.value !== 'updates');
const showUpdates = computed(() => activePanel.value !== 'node');
const title = computed(() => {
  if (activePanel.value === 'updates') return t('Aktualisierungen');
  if (activePanel.value === 'node') return t('Lokaler Knoten');
  return 'Desktop';
});

const runtimePhaseLabel = computed(() => {
  if (app.coreSourcePreference === 'remote') return t('Remote');
  if (app.coreEndpointSource === 'remote') return t('Remote-Ersatz');
  switch (app.coreRuntimeStatus?.phase) {
    case 'starting': return t('Startet');
    case 'ready': return t('Bereit');
    case 'recovering': return t('Wiederherstellung');
    case 'degraded': return t('Remote-Ersatz');
    case 'failed': return t('Fehler');
    case 'stopped': return t('Gestoppt');
    default: return t('Prüfung');
  }
});
const sourceStatus = computed(() => {
  if (app.coreSourcePreference === 'remote') return t('Netzwerk erforderlich');
  if (app.coreEndpointSource === 'remote') return t('Remote-Ersatz');
  if (app.coreRuntimeStatus?.phase === 'ready') return t('Offline bereit');
  return t(runtimePhaseLabel.value);
});

const updateBusy = computed(() => snapshotLoading.value || updateSnapshot.value?.busy === true || busyAction.value !== null);
const appTarget = computed(() =>
  updateSnapshot.value?.targets.find((target) => target.target === 'app'),
);
const APP_DOWNLOAD_RETRY_ERRORS = new Set([
  'APP_UPDATE_NETWORK_FAILED',
  'APP_UPDATE_DOWNLOAD_FAILED',
  'APP_UPDATE_CANCELLED',
  'APP_UPDATE_INTERRUPTED',
  'APP_UPDATE_REVALIDATION_REQUIRED',
  'APP_UPDATE_RECOVERY_LIMIT_REACHED',
]);
const canApplyAppUpdate = computed(
  () =>
    ports.update.capabilities.selfUpdate &&
    Boolean(ports.update.applyUpdates) &&
    !updateBusy.value &&
    (appTarget.value?.phase === 'available' ||
      (appTarget.value?.phase === 'error' &&
        appTarget.value.error?.retryable === true &&
        APP_DOWNLOAD_RETRY_ERRORS.has(appTarget.value.error.code) &&
        Boolean(appTarget.value.latestVersion))),
);
const canRelaunch = computed(
  () =>
    ports.update.capabilities.selfUpdate &&
    Boolean(ports.update.relaunchToApply) &&
    appTarget.value?.phase === 'restart-required' &&
    !updateBusy.value,
);

function targetLabel(target: UpdateTargetState['target']): string {
  return target === 'app' ? 'QED2 Desktop' : target === 'core' ? 'Core' : t('Aufgabenbank');
}

function runtimeMessage(message: string): string {
  const ready = /^Lokaler Core ist bereit \(Port (\d+); (\d+) war nicht verfügbar\)\.$/.exec(message);
  if (ready) return t('Lokaler Core ist bereit (Port {port}; {preferred} war nicht verfügbar).', { port: ready[1]!, preferred: ready[2]! });
  const retry = /^Lokaler Core wird wiederhergestellt \(Versuch (\d+)\/3\) …$/.exec(message);
  if (retry) return t('Lokaler Core wird wiederhergestellt (Versuch {attempt}/3) …', { attempt: retry[1]! });
  return t(message);
}

function updatePhaseLabel(target: UpdateTargetState): string {
  switch (target.phase) {
    case 'checking': return t('Wird geprüft …');
    case 'available': return target.target === 'app' ? t('Download verfügbar') : t('Neuer Stand verfügbar');
    case 'downloading': return t('Wird heruntergeladen …');
    case 'verifying': return t('Paket und Prüfsumme werden geprüft …');
    case 'installing': return t('Wird installiert …');
    case 'restart-required':
      return target.installMode === 'manual-package'
        ? t('Bereit zur Installation')
        : t('Bereit für Neustart');
    case 'complete': return target.target === 'app' ? t('Aktuell') : t('Im Desktop-Release gebündelt');
    case 'error': return target.error?.retryable ? t('Fehlgeschlagen · Wiederholung möglich') : t('Fehlgeschlagen');
    default: return t('Bereit');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const decimal = (value: number) => formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024)} KB`;
  return `${decimal(bytes / (1024 * 1024))} MB`;
}

function progressView(progress: OperationProgress | undefined): ProgressView | null {
  if (!progress) return null;
  const completed = Math.max(0, progress.completed);
  if (progress.unit === 'percent') {
    const value = Math.min(100, completed);
    return { determinate: true, value, max: 100, label: `${Math.round(value)} %` };
  }
  if (progress.total !== undefined && progress.total > 0) {
    const value = Math.min(progress.total, completed);
    const label = progress.unit === 'bytes'
      ? `${formatBytes(value)} / ${formatBytes(progress.total)}`
      : t('{done} / {total} Schritte', { done: Math.round(value), total: Math.round(progress.total) });
    return { determinate: true, value, max: progress.total, label };
  }
  const label = progress.unit === 'bytes'
    ? t('{bytes} geladen', { bytes: formatBytes(completed) })
    : completed > 0
      ? t('{count} abgeschlossen', { count: Math.round(completed) })
      : t('Fortschritt wird ermittelt …');
  return { determinate: false, value: 0, max: 1, label };
}

const targetViews = computed<TargetView[]>(() =>
  (updateSnapshot.value?.targets ?? []).map((state) => ({
    state,
    label: targetLabel(state.target),
    phaseLabel: updatePhaseLabel(state),
    progress: progressView(state.progress),
  })),
);

function applySnapshot(snapshot: UpdateSnapshot): void {
  updateSnapshot.value = snapshot;
  snapshotProblem.value = '';
}

async function readUpdateSnapshot(): Promise<UpdateSnapshot | undefined> {
  if (snapshotLoading.value) return updateSnapshot.value;
  if (!ports.update.getState) {
    snapshotProblem.value = t('Der Desktop-Updater stellt noch keinen Status bereit.');
    return undefined;
  }
  snapshotLoading.value = true;
  try {
    const snapshot = await ports.update.getState();
    applySnapshot(snapshot);
    return snapshot;
  } catch {
    snapshotProblem.value = t('Der Aktualisierungsstatus konnte nicht geladen werden. Bitte erneut versuchen.');
    return undefined;
  } finally {
    snapshotLoading.value = false;
  }
}

function updateCheckIsComplete(
  results: UpdateCheckResult[],
  snapshot: UpdateSnapshot | undefined,
): boolean {
  if (!snapshot) return false;
  const resultsByTarget = new Map(results.map((result) => [result.target, result]));
  const statesByTarget = new Map(snapshot.targets.map((target) => [target.target, target]));
  return UPDATE_TARGETS.every((target) => {
    const result = resultsByTarget.get(target);
    const state = statesByTarget.get(target);
    return Boolean(
      result &&
      result.latestVersion &&
      state &&
      !state.error &&
      SETTLED_CHECK_PHASES.has(state.phase),
    );
  });
}

function updateCheckNotice(results: UpdateCheckResult[], snapshot: UpdateSnapshot | undefined): string {
  const available = results.filter((item) => item.updateAvailable).length;
  const found = available
    ? available === 1 ? t('1 Aktualisierung gefunden.') : t('{count} Aktualisierungen gefunden.', { count: available })
    : '';
  if (!updateCheckIsComplete(results, snapshot)) {
    return [found, t('Nicht alle Komponenten konnten geprüft werden. Bitte erneut versuchen.')].filter(Boolean).join(' ');
  }
  const sharedDetail = results[0]?.detail;
  const allShareDetail =
    sharedDetail !== undefined && results.every((result) => result.detail === sharedDetail);
  return found || (allShareDetail ? t(sharedDetail) : t('Alle Komponenten sind aktuell.'));
}

async function recoverRuntime(action: CoreRecoveryAction): Promise<void> {
  if (!ports.coreRuntime.recover || busyAction.value) return;
  busyAction.value = action;
  problem.value = '';
  notice.value = '';
  try {
    await ports.coreRuntime.recover(action);
    await app.resolveCoreEndpoint();
    app.refreshServiceInfo();
  } catch {
    problem.value = t('Die lokale Laufzeit konnte nicht geändert werden. Bitte erneut versuchen.');
  } finally {
    busyAction.value = null;
  }
}

async function selectRuntimeSource(source: CoreSourcePreference): Promise<void> {
  if (!ports.coreRuntime.selectSource || busyAction.value) return;
  if (source === app.coreSourcePreference && (
    source === 'remote' || (app.coreEndpointSource === 'local' && app.coreRuntimeStatus?.phase === 'ready')
  )) return;
  busyAction.value = `source-${source}`;
  problem.value = '';
  notice.value = '';
  try {
    await app.selectCoreSource(source);
    app.refreshServiceInfo();
  } catch {
    problem.value = source === 'local'
      ? t('Der lokale Core konnte nicht sicher gestartet werden. Die Remote-Verbindung bleibt als Ersatz verfügbar.')
      : t('Der Remote-Core konnte nicht ausgewählt werden. Bitte erneut versuchen.');
  } finally {
    busyAction.value = null;
  }
}

async function checkForUpdates(): Promise<void> {
  if (
    !ports.update.capabilities.selfUpdate ||
    !ports.update.checkForUpdates ||
    busyAction.value
  ) return;
  busyAction.value = 'check';
  problem.value = '';
  notice.value = '';
  try {
    const result = await ports.update.checkForUpdates();
    const snapshot = await readUpdateSnapshot();
    notice.value = updateCheckNotice(result, snapshot);
  } catch {
    problem.value = t('Aktualisierungen konnten nicht geprüft werden. Bitte erneut versuchen.');
  } finally {
    busyAction.value = null;
  }
}

async function applyAppUpdate(): Promise<void> {
  if (!ports.update.applyUpdates || !canApplyAppUpdate.value) return;
  busyAction.value = 'apply';
  problem.value = '';
  notice.value = '';
  try {
    await ports.update.applyUpdates(['app']);
    await readUpdateSnapshot();
  } catch {
    const snapshot = await readUpdateSnapshot();
    const state = snapshot?.targets.find((target) => target.target === 'app');
    problem.value = state?.error?.message
      ?? t('Die Aktualisierung konnte nicht vorbereitet werden. Der aktuelle Installationsstand bleibt unverändert.');
  } finally {
    busyAction.value = null;
  }
}

async function relaunchToApply(): Promise<void> {
  if (!ports.update.relaunchToApply || !canRelaunch.value) return;
  busyAction.value = 'relaunch';
  problem.value = '';
  try {
    await ports.update.relaunchToApply();
  } catch {
    const snapshot = await readUpdateSnapshot();
    const state = snapshot?.targets.find((target) => target.target === 'app');
    if (state?.phase === 'restart-required' && state.installMode === 'manual-package') {
      notice.value = state.message ?? t('Das verifizierte Paket ist zur manuellen Installation bereit.');
    } else {
      problem.value = t('QED2 konnte für die Installation nicht neu gestartet werden.');
    }
    busyAction.value = null;
  }
}

async function openDesktopWindow(target: DesktopWindowTarget): Promise<void> {
  if (!ports.shell.openDesktopWindow || openingWindow.value !== null) return;
  openingWindow.value = target;
  problem.value = '';
  try {
    await ports.shell.openDesktopWindow(target);
  } catch {
    problem.value = t('Das Desktop-Fenster konnte nicht geöffnet werden. Bitte erneut versuchen.');
  } finally {
    openingWindow.value = null;
  }
}

async function focusRequestedSection(): Promise<void> {
  await nextTick();
  root.value?.scrollIntoView?.({ block: 'start' });
  if (isToolWindow.value) toolHeading.value?.focus({ preventScroll: true });
}

onMounted(() => {
  if (!isDesktopShell) return;
  if (ports.update.onChange) stopUpdateSubscription = ports.update.onChange(applySnapshot);
  if (showUpdates.value && ports.update.capabilities.selfUpdate) void readUpdateSnapshot();
  void focusRequestedSection();
});

watch(
  () => activePanel.value,
  () => {
    if (!isDesktopShell) return;
    problem.value = '';
    snapshotProblem.value = '';
    notice.value = '';
    if (showUpdates.value && ports.update.capabilities.selfUpdate) void readUpdateSnapshot();
    void focusRequestedSection();
  },
  { flush: 'post' },
);

onBeforeUnmount(() => stopUpdateSubscription?.());
</script>

<template>
  <section
    v-if="isDesktopShell"
    id="desktop"
    ref="root"
    class="desktop-settings settings__section q-settings-panel"
    aria-labelledby="desktop-title"
  >
    <header class="desktop-settings__head">
      <h1
        id="desktop-title"
        ref="toolHeading"
        class="desktop-settings__title q-page-title"
        tabindex="-1"
      >
        {{ title }}
      </h1>
      <span
        v-if="activePanel === 'node'"
        class="desktop-settings__state"
        :data-phase="app.coreRuntimeStatus?.phase ?? 'unknown'"
        role="status"
      >
        {{ runtimePhaseLabel }}
      </span>
    </header>

    <SettingsCard v-if="showRuntime" class="desktop-settings__subsection" aria-labelledby="runtime-title">
      <div class="desktop-settings__subhead">
        <h2 id="runtime-title" class="desktop-settings__subheading">{{ t('Aufgabenquelle') }}</h2>
        <span class="desktop-settings__source-status" role="status" aria-live="polite">{{ sourceStatus }}</span>
      </div>
      <div v-if="ports.coreRuntime.selectSource" class="desktop-settings__source" role="group" :aria-label="t('Aufgabenquelle')" :aria-busy="busyAction?.startsWith('source-') || false">
        <QButton
          variant="secondary"
          class="desktop-settings__source-option"
          data-source="local"
          :aria-pressed="app.coreSourcePreference === 'local'"
          :disabled="busyAction !== null"
          @click="selectRuntimeSource('local')"
        >
          <LoaderCircle v-if="busyAction === 'source-local'" :size="18" class="desktop-settings__spinner" aria-hidden="true" />
          <HardDrive v-else :size="18" aria-hidden="true" />
          {{ busyAction === 'source-local' ? t('Startet') : t('Lokal') }}
        </QButton>
        <QButton
          variant="secondary"
          class="desktop-settings__source-option"
          data-source="remote"
          :aria-pressed="app.coreSourcePreference === 'remote'"
          :disabled="busyAction !== null"
          @click="selectRuntimeSource('remote')"
        >
          <LoaderCircle v-if="busyAction === 'source-remote'" :size="18" class="desktop-settings__spinner" aria-hidden="true" />
          <Cloud v-else :size="18" aria-hidden="true" />
          {{ busyAction === 'source-remote' ? t('Wird gewechselt …') : t('Remote') }}
        </QButton>
      </div>
      <p v-if="app.coreRuntimeStatus?.error" class="desktop-settings__target-error" role="alert">
        {{ t(app.coreRuntimeStatus.error.message) }}
        <code>{{ app.coreRuntimeStatus.error.code }}</code>
      </p>
      <CollapsePanel :key="activePanel" :title="t('Laufzeitdetails')" :default-open="activePanel === 'node'">
        <dl class="desktop-settings__facts">
          <div><dt>Core</dt><dd>{{ app.coreInfo?.version ?? t('Wird ermittelt …') }}</dd></div>
          <div><dt>Bank</dt><dd>{{ app.coreInfo ? t(shortCommit(app.coreInfo.bank.commit)) : t('Wird ermittelt …') }}</dd></div>
        </dl>
        <p v-if="app.coreRuntimeStatus?.message" class="desktop-settings__message">{{ runtimeMessage(app.coreRuntimeStatus.message) }}</p>
        <div class="desktop-settings__actions desktop-settings__recovery">
        <QButton v-if="ports.coreRuntime.recover" variant="secondary" :disabled="busyAction !== null" @click="recoverRuntime('retry')">
          {{ busyAction === 'retry' ? t('Core startet …') : t('Core neu starten') }}
        </QButton>
        <QButton v-if="ports.coreRuntime.recover" variant="ghost" :disabled="busyAction !== null" @click="recoverRuntime('repair')">
          {{ busyAction === 'repair' ? t('Prüfung läuft …') : t('Laufzeit prüfen') }}
        </QButton>
        </div>
      </CollapsePanel>
    </SettingsCard>

    <SettingsCard
      v-if="!isToolWindow && ports.shell.openDesktopWindow"
      class="desktop-settings__subsection"
      aria-labelledby="desktop-windows-title"
    >
      <div>
        <h2 id="desktop-windows-title" class="desktop-settings__subheading">{{ t('Eigene Fenster') }}</h2>
      </div>
      <div class="desktop-settings__actions">
        <QButton
          variant="secondary"
          data-desktop-window-target="practice"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('practice')"
        >
          {{ openingWindow === 'practice' ? t('Wird geöffnet …') : t('Übungsfenster') }}
        </QButton>
        <QButton
          variant="ghost"
          data-desktop-window-target="updates"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('updates')"
        >
          {{ openingWindow === 'updates' ? t('Wird geöffnet …') : t('Update-Center') }}
        </QButton>
        <QButton
          variant="ghost"
          data-desktop-window-target="node"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('node')"
        >
          {{ openingWindow === 'node' ? t('Wird geöffnet …') : t('Knotendiagnose') }}
        </QButton>
      </div>
    </SettingsCard>

    <SettingsCard v-if="showUpdates" class="desktop-settings__subsection" aria-labelledby="updates-title">
      <div class="desktop-settings__subhead">
        <div>
          <h2 id="updates-title" class="desktop-settings__subheading">
            {{ t('Komponenten') }}
          </h2>
          <p v-if="ports.update.capabilities.manualAppInstall" class="desktop-settings__hint">
            {{ t('Unsigniert · manuelle Installation · Core & Bank enthalten') }}
          </p>
          <p v-else class="desktop-settings__hint">
            {{ t('Geprüfte Pakete · Core & Bank enthalten') }}
          </p>
        </div>
        <QButton
          variant="secondary"
          :disabled="updateBusy || !ports.update.capabilities.selfUpdate || !ports.update.checkForUpdates"
          @click="checkForUpdates"
        >
          {{ busyAction === 'check' ? t('Suche läuft …') : t('Nach Updates suchen') }}
        </QButton>
      </div>

      <p v-if="!ports.update.capabilities.selfUpdate" class="desktop-settings__message">
        {{ t('Diese Desktop-Laufzeit verwaltet Aktualisierungen außerhalb der App.') }}
      </p>
      <p v-else-if="!updateSnapshot && !snapshotProblem" class="desktop-settings__message" role="status">
        {{ t('Aktualisierungsstatus wird geladen …') }}
      </p>
      <ul v-else class="desktop-settings__targets" :aria-label="t('Aktualisierungsstatus')">
        <li v-for="target in targetViews" :key="target.state.target" class="desktop-settings__target">
          <div class="desktop-settings__target-main">
            <strong>{{ target.label }}</strong>
            <small>
              {{ t(target.state.currentVersion) }}
              <template v-if="target.state.latestVersion"> → {{ target.state.latestVersion }}</template>
            </small>
          </div>
          <div class="desktop-settings__target-status" role="status" aria-live="polite">
            <span :data-phase="target.state.phase">{{ target.phaseLabel }}</span>
            <template v-if="target.progress">
              <progress
                v-if="target.progress.determinate"
                :aria-label="`${target.label}: ${target.phaseLabel}`"
                :value="target.progress.value"
                :max="target.progress.max"
              >
                {{ target.progress.label }}
              </progress>
              <progress v-else :aria-label="`${target.label}: ${target.phaseLabel}`" />
              <small>{{ target.progress.label }}</small>
            </template>
          </div>
          <p v-if="target.state.message && target.state.target === 'app' && (target.state.phase === 'restart-required' || (target.state.phase === 'complete' && !target.state.latestVersion))" class="desktop-settings__target-message">
            {{ t(target.state.message) }}
          </p>
          <p v-if="target.state.error" class="desktop-settings__target-error" role="alert">
            {{ t(target.state.error.message) }}
            <code>{{ target.state.error.code }}</code>
          </p>
        </li>
      </ul>

      <div v-if="ports.update.capabilities.selfUpdate" class="desktop-settings__actions">
        <QButton
          v-if="canApplyAppUpdate || busyAction === 'apply'"
          :disabled="!canApplyAppUpdate"
          @click="applyAppUpdate"
        >
          <template v-if="busyAction === 'apply'">{{ t('Download läuft …') }}</template>
          <template v-else-if="appTarget?.phase === 'error'">{{ t('QED2 Desktop erneut herunterladen') }}</template>
          <template v-else>{{ t('QED2 Desktop herunterladen') }}</template>
        </QButton>
        <QButton
          v-if="canRelaunch || busyAction === 'relaunch'"
          variant="secondary"
          :disabled="busyAction === 'relaunch'"
          @click="relaunchToApply"
        >
          <template v-if="busyAction === 'relaunch'">
            {{ appTarget?.installMode === 'manual-package' ? t('Paket wird angezeigt …') : t('QED2 startet neu …') }}
          </template>
          <template v-else>
            {{ appTarget?.installMode === 'manual-package' ? t('Paket anzeigen') : t('Neu starten & installieren') }}
          </template>
        </QButton>
      </div>
    </SettingsCard>

    <QNotice v-if="snapshotProblem" tone="error">
      {{ t(snapshotProblem) }}
      <template #action>
        <QButton variant="secondary" :disabled="snapshotLoading" :aria-busy="snapshotLoading" @click="readUpdateSnapshot">
          {{ snapshotLoading ? t('Wird geladen …') : t('Erneut laden') }}
        </QButton>
      </template>
    </QNotice>
    <p v-if="problem" class="desktop-settings__problem" role="alert">{{ problem }}</p>
    <p v-if="notice" class="desktop-settings__message" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.desktop-settings {
  display: flex;
  flex-direction: column;
  gap: var(--q-space-4);
  scroll-margin-top: var(--q-space-5);
  min-width: 0;
}
.desktop-settings__head,
.desktop-settings__subhead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--q-space-3);
  flex-wrap: wrap;
}
.desktop-settings__title,
.desktop-settings__subheading,
.desktop-settings__hint,
.desktop-settings__message,
.desktop-settings__problem,
.desktop-settings__target-message,
.desktop-settings__target-error {
  margin: 0;
}
.desktop-settings__title {
  color: var(--q-ink);
  font-size: var(--q-font-title);
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.desktop-settings__title:focus { outline: none; }
.desktop-settings__hint,
.desktop-settings__target-message {
  margin-top: var(--q-space-1);
  color: var(--q-mut-2);
  font-size: var(--q-font-small);
}
.desktop-settings__state {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  padding: var(--q-space-1) var(--q-space-2);
  border: 1px solid var(--q-border-soft);
  border-radius: 999px;
  background: var(--q-panel-2);
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 700;
}
.desktop-settings__state[data-phase='ready'] {
  border-color: var(--q-ok-border);
  background: var(--q-ok-bg);
  color: var(--q-ok-ink);
}
.desktop-settings__state[data-phase='failed'],
.desktop-settings__state[data-phase='degraded'] {
  border-color: var(--q-err-border);
  background: var(--q-err-bg);
  color: var(--q-err-ink);
}
.desktop-settings__subsection {
  padding: var(--q-settings-block) var(--q-settings-inset);
}
.desktop-settings__subsection :deep(.q-settings-card__body) { gap: var(--q-space-3); }
.desktop-settings__source {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--q-space-2);
}
.desktop-settings__source-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--q-space-2);
  min-width: 0;
}
.desktop-settings__source-option[data-source='local'][aria-pressed='true'] {
  border-color: var(--q-ok-border);
  background: var(--q-ok-bg);
  color: var(--q-ok-ink);
}
.desktop-settings__source-option[data-source='remote'][aria-pressed='true'] {
  border-color: var(--q-accent);
  background: var(--q-accent-bg);
  color: var(--q-accent-strong);
}
.desktop-settings__source-status {
  font-size: var(--q-font-small);
  color: var(--q-mut);
}
.desktop-settings__recovery { margin-top: var(--q-space-3); }
.desktop-settings__spinner { animation: desktop-spin 1s linear infinite; }
@keyframes desktop-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .desktop-settings__spinner { animation: none; }
}
.desktop-settings__subheading {
  color: var(--q-ink);
  font-size: var(--q-font-ui);
  font-weight: 800;
}
.desktop-settings__facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: var(--q-space-2);
  margin: 0;
}
.desktop-settings__facts > div {
  min-width: 0;
  padding: var(--q-space-3);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control);
  background: var(--q-panel);
}
.desktop-settings__facts dt {
  color: var(--q-faint);
  font-size: var(--q-font-small);
}
.desktop-settings__facts dd {
  margin: var(--q-space-1) 0 0;
  overflow: hidden;
  color: var(--q-ink);
  font: 600 var(--q-font-small)/1.5 ui-monospace, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desktop-settings__actions {
  display: flex;
  gap: var(--q-space-2);
  flex-wrap: wrap;
}
.desktop-settings__targets {
  display: flex;
  flex-direction: column;
  gap: var(--q-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.desktop-settings__target {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 0.8fr);
  gap: var(--q-space-2) var(--q-space-3);
  padding: var(--q-space-3);
  border: 1px solid var(--q-border-soft);
  border-radius: var(--q-radius-control);
  background: var(--q-card);
}
.desktop-settings__target-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.desktop-settings__target-main strong { color: var(--q-ink); font-size: var(--q-font-ui); }
.desktop-settings__target-main small {
  overflow: hidden;
  color: var(--q-mut-2);
  font: 500 var(--q-font-small)/1.5 ui-monospace, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desktop-settings__target-status {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--q-space-1);
  color: var(--q-mut);
  font-size: var(--q-font-small);
  font-weight: 700;
  text-align: right;
}
.desktop-settings__target-status span[data-phase='restart-required'],
.desktop-settings__target-status span[data-phase='available'] { color: var(--q-accent-strong); }
.desktop-settings__target-status span[data-phase='error'] { color: var(--q-err-ink); }
.desktop-settings__target-status progress { width: min(180px, 100%); accent-color: var(--q-accent-strong); }
.desktop-settings__target-status small { color: var(--q-mut-2); font-weight: 500; }
.desktop-settings__target-message,
.desktop-settings__target-error { grid-column: 1 / -1; }
.desktop-settings__target-error,
.desktop-settings__problem {
  padding: var(--q-space-3);
  border: 1px solid var(--q-err-border);
  border-radius: var(--q-radius-control);
  background: var(--q-err-bg);
  color: var(--q-err-ink);
  font-size: var(--q-font-small);
}
.desktop-settings__target-error code {
  display: inline-block;
  margin-left: var(--q-space-1);
  color: inherit;
  font-size: var(--q-font-small);
  overflow-wrap: anywhere;
}
.desktop-settings__message { color: var(--q-mut); font-size: var(--q-font-small); }
@media (max-width: 560px) {
  .desktop-settings__target { grid-template-columns: 1fr; }
  .desktop-settings__target-status { align-items: flex-start; text-align: left; }
  .desktop-settings__target-status progress { width: 100%; }
}
</style>
