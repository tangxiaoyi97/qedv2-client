<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  type CoreRecoveryAction,
  type DesktopWindowTarget,
  type OperationProgress,
  type UpdateCheckResult,
  type UpdateSnapshot,
  type UpdateTargetState,
} from '@qed2/core-logic';
import { QButton } from '@qed2/ui';
import { ports } from '../../services.js';
import { useAppStore } from '../../stores/app.js';
import { shortCommit } from '../../version-info.js';

type DesktopWindow = 'updates' | 'node' | null;

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

const route = useRoute();
const app = useAppStore();
const root = ref<HTMLElement | null>(null);
const toolHeading = ref<HTMLElement | null>(null);
const busyAction = ref<CoreRecoveryAction | 'check' | 'apply' | 'relaunch' | null>(null);
const problem = ref('');
const snapshotProblem = ref('');
const notice = ref('');
const updateSnapshot = ref<UpdateSnapshot>();
const openingWindow = ref<DesktopWindowTarget | null>(null);
let stopUpdateSubscription: (() => void) | undefined;

const isDesktopShell = ports.shell.capabilities.desktop;
const desktopWindow = computed<DesktopWindow>(() => {
  const value = route.query.desktopWindow;
  return value === 'updates' || value === 'node' ? value : null;
});
const isToolWindow = computed(() => desktopWindow.value !== null);
const showRuntime = computed(() => desktopWindow.value !== 'updates');
const showUpdates = computed(() => desktopWindow.value !== 'node');
const title = computed(() => {
  if (desktopWindow.value === 'updates') return 'Aktualisierungen';
  if (desktopWindow.value === 'node') return 'Lokaler Knoten';
  return 'Desktop & lokaler Knoten';
});
const subtitle = computed(() => {
  if (desktopWindow.value === 'updates') return 'QED2 Desktop sicher laden und anwenden';
  if (desktopWindow.value === 'node') return 'Lokaler Core, Laufzeit und Offline-Betrieb';
  return 'Lokale Laufzeit und Desktop-Aktualisierungen';
});

const runtimePhaseLabel = computed(() => {
  switch (app.coreRuntimeStatus?.phase) {
    case 'starting': return 'Lokaler Core startet';
    case 'ready': return 'Lokaler Core ist bereit';
    case 'recovering': return 'Lokaler Core wird wiederhergestellt';
    case 'degraded': return 'Remote-Ersatz ist aktiv';
    case 'failed': return 'Lokaler Core benötigt Hilfe';
    case 'stopped': return 'Lokaler Core ist gestoppt';
    default: return 'Status wird ermittelt';
  }
});

const updateBusy = computed(() => updateSnapshot.value?.busy === true || busyAction.value !== null);
const appTarget = computed(() =>
  updateSnapshot.value?.targets.find((target) => target.target === 'app'),
);
const canApplyAppUpdate = computed(
  () =>
    ports.update.capabilities.selfUpdate &&
    Boolean(ports.update.applyUpdates) &&
    !updateBusy.value &&
    (appTarget.value?.phase === 'available' ||
      (appTarget.value?.phase === 'error' && appTarget.value.error?.retryable === true)),
);
const canRelaunch = computed(
  () =>
    ports.update.capabilities.selfUpdate &&
    Boolean(ports.update.relaunchToApply) &&
    appTarget.value?.phase === 'restart-required' &&
    !updateBusy.value,
);

function targetLabel(target: UpdateTargetState['target']): string {
  return target === 'app' ? 'QED2 Desktop' : target === 'core' ? 'Core' : 'Aufgabenbank';
}

function updatePhaseLabel(target: UpdateTargetState): string {
  switch (target.phase) {
    case 'checking': return 'Wird geprüft …';
    case 'available': return target.target === 'app' ? 'Download verfügbar' : 'Neuer Stand verfügbar';
    case 'downloading': return 'Wird heruntergeladen …';
    case 'verifying': return 'Paket und Prüfsumme werden geprüft …';
    case 'installing': return 'Wird installiert …';
    case 'restart-required': return 'Bereit für Neustart';
    case 'complete': return 'Aktuell';
    case 'error': return target.error?.retryable ? 'Fehlgeschlagen · Wiederholung möglich' : 'Fehlgeschlagen';
    default: return 'Bereit';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      : `${Math.round(value)} / ${Math.round(progress.total)} Schritte`;
    return { determinate: true, value, max: progress.total, label };
  }
  const label = progress.unit === 'bytes'
    ? `${formatBytes(completed)} geladen`
    : completed > 0
      ? `${Math.round(completed)} abgeschlossen`
      : 'Fortschritt wird ermittelt …';
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
  if (!ports.update.getState) {
    snapshotProblem.value = 'Der Desktop-Updater stellt noch keinen Status bereit.';
    return undefined;
  }
  try {
    const snapshot = await ports.update.getState();
    applySnapshot(snapshot);
    return snapshot;
  } catch {
    snapshotProblem.value = 'Der Aktualisierungsstatus konnte nicht geladen werden. Bitte erneut versuchen.';
    return undefined;
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
    ? `${available} Aktualisierung${available === 1 ? '' : 'en'} gefunden.`
    : '';
  if (!updateCheckIsComplete(results, snapshot)) {
    return `${found}${found ? ' ' : ''}Nicht alle Komponenten konnten geprüft werden. Bitte erneut versuchen.`;
  }
  return found || 'Alle Komponenten sind aktuell.';
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
    problem.value = 'Die lokale Laufzeit konnte nicht geändert werden. Bitte erneut versuchen.';
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
    problem.value = 'Aktualisierungen konnten nicht geprüft werden. Bitte erneut versuchen.';
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
    problem.value = 'QED2 Desktop konnte nicht heruntergeladen werden. Du kannst den Download erneut starten.';
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
      notice.value = state.message ?? 'Das verifizierte Paket ist zur manuellen Installation bereit.';
    } else {
      problem.value = 'QED2 konnte für die Installation nicht neu gestartet werden.';
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
    problem.value = 'Das Desktop-Fenster konnte nicht geöffnet werden. Bitte erneut versuchen.';
  } finally {
    openingWindow.value = null;
  }
}

async function focusRequestedSection(): Promise<void> {
  if (route.query.section !== 'desktop' && desktopWindow.value === null) return;
  await nextTick();
  root.value?.scrollIntoView?.({ block: 'start' });
  if (isToolWindow.value) toolHeading.value?.focus({ preventScroll: true });
}

onMounted(() => {
  if (!isDesktopShell) return;
  if (ports.update.onChange) stopUpdateSubscription = ports.update.onChange(applySnapshot);
  if (showUpdates.value) void readUpdateSnapshot();
  void focusRequestedSection();
});

watch(
  () => [route.query.section, route.query.desktopWindow] as const,
  () => {
    if (!isDesktopShell) return;
    problem.value = '';
    snapshotProblem.value = '';
    notice.value = '';
    if (showUpdates.value) void readUpdateSnapshot();
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
    class="desktop-settings settings__section"
    :class="{ 'desktop-settings--tool': isToolWindow }"
    aria-labelledby="desktop-title"
  >
    <header class="desktop-settings__head">
      <div>
        <h1
          v-if="isToolWindow"
          id="desktop-title"
          ref="toolHeading"
          class="desktop-settings__title q-page-title"
          tabindex="-1"
        >
          {{ title }}
        </h1>
        <h2 v-else id="desktop-title" class="desktop-settings__title">{{ title }}</h2>
        <p class="desktop-settings__subtitle">{{ subtitle }}</p>
      </div>
      <span
        v-if="showRuntime"
        class="desktop-settings__state"
        :data-phase="app.coreRuntimeStatus?.phase ?? 'unknown'"
        role="status"
      >
        {{ runtimePhaseLabel }}
      </span>
    </header>

    <div
      v-if="!isToolWindow && ports.shell.openDesktopWindow"
      class="desktop-settings__subsection"
      aria-labelledby="desktop-windows-title"
    >
      <div>
        <h3 id="desktop-windows-title" class="desktop-settings__subheading">Eigene Fenster</h3>
        <p class="desktop-settings__hint">Parallel arbeiten, ohne den aktuellen Bereich zu verlassen.</p>
      </div>
      <div class="desktop-settings__actions">
        <QButton
          variant="secondary"
          data-desktop-window-target="practice"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('practice')"
        >
          {{ openingWindow === 'practice' ? 'Wird geöffnet …' : 'Übungsfenster öffnen' }}
        </QButton>
        <QButton
          variant="ghost"
          data-desktop-window-target="updates"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('updates')"
        >
          {{ openingWindow === 'updates' ? 'Wird geöffnet …' : 'Update-Center öffnen' }}
        </QButton>
        <QButton
          variant="ghost"
          data-desktop-window-target="node"
          :disabled="openingWindow !== null"
          @click="openDesktopWindow('node')"
        >
          {{ openingWindow === 'node' ? 'Wird geöffnet …' : 'Knotendiagnose öffnen' }}
        </QButton>
      </div>
    </div>

    <div v-if="showRuntime" class="desktop-settings__subsection" aria-labelledby="runtime-title">
      <component :is="isToolWindow ? 'h2' : 'h3'" id="runtime-title" class="desktop-settings__subheading">
        Lokale Laufzeit
      </component>
      <dl class="desktop-settings__facts">
        <div><dt>Quelle</dt><dd>{{ app.coreEndpointSource === 'local' ? 'Lokal' : 'Remote' }}</dd></div>
        <div><dt>Core</dt><dd>{{ app.coreInfo?.version ?? 'Wird ermittelt …' }}</dd></div>
        <div><dt>Aufgabenbank</dt><dd>{{ app.coreInfo ? shortCommit(app.coreInfo.bank.commit) : 'Wird ermittelt …' }}</dd></div>
      </dl>
      <p v-if="app.coreRuntimeStatus?.message" class="desktop-settings__message">
        {{ app.coreRuntimeStatus.message }}
      </p>
      <p v-if="app.coreRuntimeStatus?.error" class="desktop-settings__target-error" role="alert">
        {{ app.coreRuntimeStatus.error.message }}
        <code>{{ app.coreRuntimeStatus.error.code }}</code>
      </p>
      <div class="desktop-settings__actions">
        <QButton v-if="ports.coreRuntime.recover" variant="secondary" :disabled="busyAction !== null" @click="recoverRuntime('retry')">
          {{ busyAction === 'retry' ? 'Core startet …' : 'Core neu starten' }}
        </QButton>
        <QButton v-if="ports.coreRuntime.recover" variant="ghost" :disabled="busyAction !== null" @click="recoverRuntime('repair')">
          {{ busyAction === 'repair' ? 'Prüfung läuft …' : 'Laufzeit prüfen' }}
        </QButton>
        <QButton
          v-if="ports.coreRuntime.recover && app.coreEndpointSource === 'local'"
          variant="ghost"
          :disabled="busyAction !== null"
          @click="recoverRuntime('use-remote')"
        >
          Remote verwenden
        </QButton>
      </div>
    </div>

    <div v-if="showUpdates" class="desktop-settings__subsection" aria-labelledby="updates-title">
      <div class="desktop-settings__subhead">
        <div>
          <component :is="isToolWindow ? 'h2' : 'h3'" id="updates-title" class="desktop-settings__subheading">
            Komponenten
          </component>
          <p class="desktop-settings__hint">
            macOS- und Windows-Pakete sind signiert. Unterstützte Updates werden auf allen Plattformen
            anhand veröffentlichter Metadaten und Prüfsummen geprüft; Core und Aufgabenbank folgen dem Desktop-Release.
          </p>
        </div>
        <QButton
          variant="secondary"
          :disabled="updateBusy || !ports.update.capabilities.selfUpdate || !ports.update.checkForUpdates"
          @click="checkForUpdates"
        >
          {{ busyAction === 'check' ? 'Suche läuft …' : 'Nach Updates suchen' }}
        </QButton>
      </div>

      <p v-if="!ports.update.capabilities.selfUpdate" class="desktop-settings__message">
        Diese Desktop-Laufzeit verwaltet Aktualisierungen außerhalb der App.
      </p>
      <p v-else-if="!updateSnapshot" class="desktop-settings__message" role="status">
        Aktualisierungsstatus wird geladen …
      </p>
      <ul v-else class="desktop-settings__targets" aria-label="Aktualisierungsstatus">
        <li v-for="target in targetViews" :key="target.state.target" class="desktop-settings__target">
          <div class="desktop-settings__target-main">
            <strong>{{ target.label }}</strong>
            <small>
              {{ target.state.currentVersion }}
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
          <p v-if="target.state.message" class="desktop-settings__target-message">
            {{ target.state.message }}
          </p>
          <p v-if="target.state.error" class="desktop-settings__target-error" role="alert">
            {{ target.state.error.message }}
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
          <template v-if="busyAction === 'apply'">Download läuft …</template>
          <template v-else-if="appTarget?.phase === 'error'">QED2 Desktop erneut herunterladen</template>
          <template v-else>QED2 Desktop herunterladen</template>
        </QButton>
        <QButton
          v-if="canRelaunch || busyAction === 'relaunch'"
          variant="secondary"
          :disabled="busyAction === 'relaunch'"
          @click="relaunchToApply"
        >
          <template v-if="busyAction === 'relaunch'">
            {{ appTarget?.installMode === 'manual-package' ? 'Paket wird angezeigt …' : 'QED2 startet neu …' }}
          </template>
          <template v-else>
            {{ appTarget?.installMode === 'manual-package' ? 'Paket anzeigen' : 'Neu starten & installieren' }}
          </template>
        </QButton>
      </div>
    </div>

    <p v-if="snapshotProblem" class="desktop-settings__problem" role="alert">{{ snapshotProblem }}</p>
    <p v-if="problem" class="desktop-settings__problem" role="alert">{{ problem }}</p>
    <p v-if="notice" class="desktop-settings__message" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.desktop-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  scroll-margin-top: 20px;
}
.desktop-settings__head,
.desktop-settings__subhead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.desktop-settings__title,
.desktop-settings__subtitle,
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
  font-size: 18px;
  font-weight: 800;
  line-height: 1.25;
}
.desktop-settings--tool .desktop-settings__title {
  font-size: 22px;
  letter-spacing: -0.01em;
}
.desktop-settings__title:focus { outline: none; }
.desktop-settings__subtitle,
.desktop-settings__hint,
.desktop-settings__target-message {
  margin-top: 3px;
  color: var(--q-mut-2);
  font-size: 12px;
}
.desktop-settings__state {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  padding: 4px 9px;
  border: 1px solid var(--q-border-soft);
  border-radius: 999px;
  background: var(--q-panel-2);
  color: var(--q-mut);
  font-size: 12px;
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
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--q-border-soft);
}
.desktop-settings__subheading {
  color: var(--q-ink);
  font-size: 14px;
  font-weight: 800;
}
.desktop-settings__facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}
.desktop-settings__facts > div {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--q-border-soft);
  border-radius: 9px;
  background: var(--q-panel);
}
.desktop-settings__facts dt {
  color: var(--q-faint);
  font-size: 11px;
}
.desktop-settings__facts dd {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--q-ink);
  font: 600 12px ui-monospace, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desktop-settings__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.desktop-settings__targets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.desktop-settings__target {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 0.8fr);
  gap: 6px 14px;
  padding: 12px;
  border: 1px solid var(--q-border-soft);
  border-radius: 10px;
  background: var(--q-card);
}
.desktop-settings__target-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.desktop-settings__target-main strong { color: var(--q-ink); font-size: 13px; }
.desktop-settings__target-main small {
  overflow: hidden;
  color: var(--q-mut-2);
  font: 500 11px ui-monospace, Menlo, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desktop-settings__target-status {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  color: var(--q-mut);
  font-size: 12px;
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
  padding: 9px 11px;
  border: 1px solid var(--q-err-border);
  border-radius: 8px;
  background: var(--q-err-bg);
  color: var(--q-err-ink);
  font-size: 12px;
}
.desktop-settings__target-error code {
  display: inline-block;
  margin-left: 5px;
  color: inherit;
  font-size: 10px;
}
.desktop-settings__message { color: var(--q-mut); font-size: 12px; }
@media (max-width: 560px) {
  .desktop-settings__facts { grid-template-columns: 1fr; }
  .desktop-settings__target { grid-template-columns: 1fr; }
  .desktop-settings__target-status { align-items: flex-start; text-align: left; }
  .desktop-settings__target-status progress { width: 100%; }
}
</style>
