/**
 * Progress store: reactive view over the local archive + the sync loop.
 * All computation (FSRS, mastery, checksum, merge dispatch) lives in
 * @qed2/core-logic — this store only binds it to the UI.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  archiveChecksum,
  buildResolvedArchive,
  performSync,
  submitResolution,
  ApiError,
  NetworkError,
  type ArchiveContent,
  type GradeResult,
  type LocalArchive,
  type SyncConflict,
  type RecommendUserState,
} from '@qed2/core-logic';
import { archiveStore } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';
  message?: string;
  at?: Date;
}

export const useProgressStore = defineStore('progress', () => {
  const archive = shallowRef<LocalArchive>({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  const syncStatus = ref<SyncStatus>({ state: 'idle' });
  const conflict = shallowRef<SyncConflict | undefined>();
  const loaded = ref(false);

  const practicedParts = computed(() => archive.value.content.perPart.length);
  const masteryEntries = computed(() =>
    archive.value.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
  );
  const dueCount = computed(() => {
    const now = Date.now();
    return archive.value.content.perPart.filter((p) => new Date(p.fsrs.due).getTime() <= now).length;
  });

  async function init(): Promise<void> {
    archive.value = await archiveStore.load();
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    archive.value = await archiveStore.load();
  }

  /** Per-part progress lookup for browse/list views. */
  const partState = computed(() => {
    const map = new Map<string, { correct: boolean; awardedPoints: number; due: boolean }>();
    const now = Date.now();
    for (const p of archive.value.content.perPart) {
      map.set(p.partId, {
        correct: p.lastResult?.correct ?? false,
        awardedPoints: p.lastResult?.awardedPoints ?? 0,
        due: new Date(p.fsrs.due).getTime() <= now,
      });
    }
    return map;
  });

  async function applyGrade(input: {
    partId: string;
    competencyCodes: string[];
    result: GradeResult;
  }): Promise<void> {
    archive.value = await archiveStore.applyGrade({
      partId: input.partId,
      competencyCodes: input.competencyCodes,
      verdict: input.result.verdict,
      awardedPoints: input.result.awardedPoints,
      maxPoints: input.result.maxPoints,
      now: new Date(),
    });
  }

  async function toUserState(): Promise<RecommendUserState> {
    return archiveStore.toUserState();
  }

  /**
   * Run one sync round. Guests and offline users no-op gracefully.
   * On conflict the dialog state is populated; resolution happens via
   * resolveConflict().
   */
  async function syncNow(opts: { quiet: boolean }): Promise<void> {
    const auth = useAuthStore();
    const app = useAppStore();
    if (!auth.isLoggedIn) return;
    syncStatus.value = { state: 'syncing' };
    try {
      const { outcome, archive: next } = await performSync(app.serverClient, archive.value);
      if (outcome.type === 'conflict') {
        conflict.value = outcome.conflict;
        syncStatus.value = { state: 'conflict', at: new Date() };
        return;
      }
      archive.value = next;
      await archiveStore.save(next);
      syncStatus.value = { state: 'synced', at: new Date() };
    } catch (e) {
      if (e instanceof NetworkError) {
        syncStatus.value = { state: 'offline', at: new Date() };
      } else if (e instanceof ApiError && e.status === 401) {
        syncStatus.value = { state: 'error', message: 'Sitzung abgelaufen — bitte neu anmelden.', at: new Date() };
      } else {
        syncStatus.value = { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
        if (!opts.quiet) throw e;
      }
    }
  }

  /** User picked sides in the conflict dialog. */
  async function resolveConflict(choices: Record<string, 'server' | 'local'>): Promise<void> {
    const app = useAppStore();
    const current = conflict.value;
    if (!current) return;
    const resolved: ArchiveContent = buildResolvedArchive(current, choices);
    const { outcome, archive: next } = await submitResolution(app.serverClient, current, resolved);
    if (outcome.type === 'conflict') {
      // Another device wrote while the user was choosing — new round.
      conflict.value = outcome.conflict;
      return;
    }
    conflict.value = undefined;
    if (next) {
      archive.value = next;
      await archiveStore.save(next);
    }
    syncStatus.value = { state: 'synced', at: new Date() };
  }

  function dismissConflict(): void {
    // Allowed: the user can postpone; local progress keeps accumulating and
    // the next sync will re-surface the conflict.
    conflict.value = undefined;
    syncStatus.value = { state: 'idle' };
  }

  function localChecksum(): string {
    return archiveChecksum(archive.value.content);
  }

  return {
    archive,
    syncStatus,
    conflict,
    loaded,
    practicedParts,
    masteryEntries,
    dueCount,
    partState,
    init,
    refresh,
    applyGrade,
    toUserState,
    syncNow,
    resolveConflict,
    dismissConflict,
    localChecksum,
  };
});
