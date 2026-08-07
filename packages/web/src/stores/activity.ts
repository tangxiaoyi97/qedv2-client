import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { localActivityRange } from '@qed2/core-logic';
import { historyLog } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';
import { useProgressStore } from './progress.js';

export type ActivityStatus = 'idle' | 'loading' | 'ready' | 'error';

const DEFAULT_DAYS = 84;

/**
 * One activity authority for every heatmap. Guests read the durable local
 * history; signed-in users read the server audit stream. Cloud snapshots are
 * deliberately not persisted: displaying an old non-empty cache beside an
 * authoritative empty account is worse than showing a retriable error.
 */
export const useActivityStore = defineStore('activity', () => {
  const app = useAppStore();
  const auth = useAuthStore();
  const progress = useProgressStore();
  const activity = ref<Record<string, number>>({});
  const status = ref<ActivityStatus>('idle');
  const message = ref<string | undefined>();
  const updatedAt = ref<string | undefined>();
  const loadedDays = ref(0);
  const requestedDays = ref(DEFAULT_DAYS);
  let generation = 0;

  const sourceKey = computed(() =>
    auth.session?.user.id ? `cloud:${auth.session.user.id}` : 'local',
  );
  const cloudMode = computed(() => sourceKey.value.startsWith('cloud:'));
  const loading = computed(() => status.value === 'loading');
  const error = computed(() => (status.value === 'error' ? message.value : undefined));
  const cloudIncompleteMessage = computed(() => {
    if (!cloudMode.value || progress.attemptUploadStatus.state === 'idle') return undefined;
    return progress.attemptUploadStatus.message ??
      (progress.attemptUploadStatus.state === 'uploading'
        ? 'Antwortverlauf wird hochgeladen …'
        : 'Der Cloud-Verlauf ist noch nicht vollständig.');
  });

  function reset(): void {
    generation += 1;
    activity.value = {};
    loadedDays.value = 0;
    updatedAt.value = undefined;
    status.value = 'idle';
    message.value = undefined;
  }

  async function refresh(
    days = Math.max(DEFAULT_DAYS, loadedDays.value),
    options: { force?: boolean; now?: Date } = {},
  ): Promise<void> {
    requestedDays.value = Math.max(requestedDays.value, Math.floor(days));
    const wantedDays = Math.max(1, requestedDays.value);
    const source = sourceKey.value;
    if (!options.force && status.value === 'ready' && loadedDays.value >= wantedDays) return;
    const request = ++generation;
    const now = options.now ?? new Date();
    status.value = 'loading';
    message.value = undefined;

    try {
      let next: Record<string, number>;
      if (cloudMode.value) {
        const range = localActivityRange(wantedDays, now);
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        next = (await app.serverClient.getHistoryActivity({ ...range, timeZone })).activity;
      } else {
        next = await historyLog.dailyActivity(wantedDays, now);
      }
      if (request !== generation || source !== sourceKey.value) return;
      activity.value = next;
      loadedDays.value = wantedDays;
      updatedAt.value = new Date().toISOString();
      status.value = 'ready';
    } catch {
      if (request !== generation || source !== sourceKey.value) return;
      // Never keep a misleading cloud snapshot after an authoritative read
      // failed. Local archive/history remains untouched and can retry later.
      activity.value = {};
      loadedDays.value = 0;
      updatedAt.value = undefined;
      message.value = 'Aktivität konnte nicht geladen werden. Bitte versuche es erneut.';
      status.value = 'error';
    }
  }

  async function ensure(days = DEFAULT_DAYS, now = new Date()): Promise<void> {
    await refresh(days, { now });
  }

  watch(sourceKey, () => {
    const shouldReload = requestedDays.value > 0;
    reset();
    if (shouldReload) void refresh(requestedDays.value, { force: true });
  });

  watch(
    () => progress.historyVersion,
    () => {
      if (!cloudMode.value) void refresh(requestedDays.value, { force: true });
    },
  );

  watch(
    () => progress.cloudHistoryVersion,
    () => {
      if (cloudMode.value) void refresh(requestedDays.value, { force: true });
    },
  );

  return {
    activity,
    status,
    message,
    updatedAt,
    loadedDays,
    cloudMode,
    loading,
    error,
    cloudIncompleteMessage,
    ensure,
    refresh,
  };
});
