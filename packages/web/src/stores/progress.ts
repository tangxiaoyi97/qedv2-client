/**
 * Progress store: reactive view over the local archive + the sync loop +
 * the grading system (grading supplement). All computation (FSRS, mastery,
 * checksum, merge dispatch, grading→FSRS mapping) lives in @qed2/core-logic —
 * this store only binds it to the UI.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
  archiveChecksum,
  assessLoginArchives,
  buildResolvedArchive,
  canonicalizeArchive,
  overwriteServerArchive,
  performSync,
  submitResolution,
  gradingOf,
  isPartDue,
  isPracticed,
  ApiError,
  NetworkError,
  type ArchiveContent,
  type ArchiveSideSummary,
  type FsrsState,
  type GradeResult,
  type Grading,
  type GradingOrUnseen,
  type HistoryEntry,
  type LocalArchive,
  type ServerArchiveState,
  type SyncConflict,
  type RecommendUserState,
} from '@qed2/core-logic';
import { archiveStore, historyLog } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';
  message?: string;
  at?: Date;
}

export interface PartStateView {
  grading: GradingOrUnseen;
  starred: boolean;
  practiced: boolean;
  correct: boolean;
  awardedPoints: number;
  due: boolean;
}

export interface ArchiveChoice {
  serverState: ServerArchiveState;
  server: ArchiveSideSummary;
  local: ArchiveSideSummary;
}

export const useProgressStore = defineStore('progress', () => {
  const archive = shallowRef<LocalArchive>({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  const syncStatus = ref<SyncStatus>({ state: 'idle' });
  const conflict = shallowRef<SyncConflict | undefined>();
  /** Login-time archive choice (upgrade doc §2) — feeds ArchiveChoiceDialog. */
  const archiveChoice = shallowRef<ArchiveChoice | undefined>();
  const loaded = ref(false);
  /** Bumped when the history log changes so views can re-query it. */
  const historyVersion = ref(0);

  const practicedParts = computed(
    () => archive.value.content.perPart.filter((p) => isPracticed(p)).length,
  );
  const masteryEntries = computed(() =>
    archive.value.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
  );
  const dueCount = computed(() => {
    const now = new Date();
    return archive.value.content.perPart.filter((p) => isPartDue(p, now)).length;
  });

  /** Counts per grading state (incl. excluded; unseen is unknowable here). */
  const gradingCounts = computed<Record<Grading, number>>(() => {
    const counts: Record<Grading, number> = { good: 0, careless: 0, meh: 0, baffled: 0, excluded: 0 };
    for (const p of archive.value.content.perPart) {
      if (p.grading) counts[p.grading] += 1;
    }
    return counts;
  });

  const starredCount = computed(
    () => archive.value.content.perPart.filter((p) => p.starred).length,
  );

  const excludedPartIds = computed(
    () => new Set(archive.value.content.perPart.filter((p) => p.grading === 'excluded').map((p) => p.partId)),
  );

  async function init(): Promise<void> {
    archive.value = await archiveStore.load();
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    archive.value = await archiveStore.load();
  }

  /** Per-part progress lookup for browse/list views. */
  const partState = computed(() => {
    const map = new Map<string, PartStateView>();
    const now = new Date();
    for (const p of archive.value.content.perPart) {
      map.set(p.partId, {
        grading: gradingOf(p),
        starred: p.starred,
        practiced: isPracticed(p),
        correct: p.lastResult?.correct ?? false,
        awardedPoints: p.lastResult?.awardedPoints ?? 0,
        due: isPartDue(p, now),
      });
    }
    return map;
  });

  /**
   * Record one graded part. Returns the pre-answer FSRS snapshot so a manual
   * grading override of the SAME answer event can rebase (supplement §1.2).
   */
  async function applyGrade(input: {
    partId: string;
    questionId: string;
    competencyCodes: string[];
    result: GradeResult;
    elapsedMs?: number;
  }): Promise<{ grading: Grading; previousFsrs: FsrsState | undefined }> {
    const res = await archiveStore.applyGrade({
      partId: input.partId,
      competencyCodes: input.competencyCodes,
      verdict: input.result.verdict,
      awardedPoints: input.result.awardedPoints,
      maxPoints: input.result.maxPoints,
      now: new Date(),
    });
    archive.value = res.archive;
    const entry: HistoryEntry = {
      partId: input.partId,
      questionId: input.questionId,
      verdict: input.result.verdict,
      awardedPoints: input.result.awardedPoints,
      maxPoints: input.result.maxPoints,
      grading: res.grading,
      gradedAt: new Date().toISOString(),
    };
    if (input.elapsedMs !== undefined) entry.elapsedMs = input.elapsedMs;
    await historyLog.append(entry);
    historyVersion.value += 1;
    return { grading: res.grading, previousFsrs: res.previousFsrs };
  }

  /** Manual grading (menu) — always overrides; see ArchiveStore.setGrading. */
  async function setGrading(input: {
    partId: string;
    grading: Grading;
    baseFsrs?: FsrsState | undefined;
  }): Promise<void> {
    archive.value = await archiveStore.setGrading({
      partId: input.partId,
      grading: input.grading,
      now: new Date(),
      baseFsrs: input.baseFsrs,
    });
  }

  async function setStarred(partId: string, starred: boolean): Promise<void> {
    archive.value = await archiveStore.setStarred(partId, starred, new Date());
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

  /**
   * ONE-TIME login reconciliation (upgrade doc §2.2). Quiet cases resolve
   * silently; only "both sides differ" opens the choice dialog. Network
   * failure degrades to the offline state — the user continues locally.
   */
  async function reconcileOnLogin(): Promise<void> {
    const app = useAppStore();
    syncStatus.value = { state: 'syncing' };
    try {
      const serverState = await app.serverClient.getState();
      const assessment = assessLoginArchives(archive.value, serverState);
      switch (assessment.kind) {
        case 'adopt-server':
        case 'in-sync':
          archive.value = assessment.archive;
          await archiveStore.save(assessment.archive);
          syncStatus.value = { state: 'synced', at: new Date() };
          return;
        case 'upload-local': {
          // Empty cloud archive — a plain sync from the server's version
          // fast-forwards the local content up (no data on either side lost).
          const { outcome, archive: next } = await performSync(app.serverClient, {
            content: archive.value.content,
            baseVersion: assessment.baseVersion,
          });
          if (outcome.type === 'conflict') {
            conflict.value = outcome.conflict;
            syncStatus.value = { state: 'conflict', at: new Date() };
            return;
          }
          archive.value = next;
          await archiveStore.save(next);
          syncStatus.value = { state: 'synced', at: new Date() };
          return;
        }
        case 'choice-needed':
          archiveChoice.value = {
            serverState: assessment.serverState,
            server: assessment.server,
            local: assessment.local,
          };
          syncStatus.value = { state: 'idle' };
          return;
      }
    } catch (e) {
      syncStatus.value =
        e instanceof NetworkError
          ? { state: 'offline', at: new Date() }
          : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
    }
  }

  /** The user's pick in the archive-choice dialog (§2.3). */
  async function resolveArchiveChoice(pick: 'merge' | 'server' | 'local'): Promise<void> {
    const app = useAppStore();
    const choice = archiveChoice.value;
    if (!choice) return;
    try {
      if (pick === 'server') {
        const adopted: LocalArchive = {
          content: canonicalizeArchive({
            perPart: choice.serverState.perPart,
            perCompetency: choice.serverState.perCompetency,
          }),
          baseVersion: choice.serverState.archiveVersion,
        };
        archive.value = adopted;
        await archiveStore.save(adopted);
        syncStatus.value = { state: 'synced', at: new Date() };
      } else if (pick === 'local') {
        const { outcome, archive: next } = await overwriteServerArchive(
          app.serverClient,
          choice.serverState.archiveVersion,
          archive.value.content,
        );
        if (outcome.type === 'conflict') {
          // Another device wrote while choosing — re-run the assessment.
          archiveChoice.value = undefined;
          await reconcileOnLogin();
          return;
        }
        if (next) {
          archive.value = next;
          await archiveStore.save(next);
        }
        syncStatus.value = { state: 'synced', at: new Date() };
      } else {
        // merge — the recommended path: a regular contract-§5 sync round;
        // a true conflict falls through to the per-entry conflict dialog.
        archiveChoice.value = undefined;
        await syncNow({ quiet: false });
      }
      archiveChoice.value = undefined;
    } catch (e) {
      syncStatus.value =
        e instanceof NetworkError
          ? { state: 'offline', at: new Date() }
          : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
      archiveChoice.value = undefined;
    }
  }

  /** Postponing is allowed — the next login re-offers the choice (§2.4). */
  function dismissArchiveChoice(): void {
    archiveChoice.value = undefined;
    syncStatus.value = { state: 'idle' };
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
    archiveChoice,
    loaded,
    historyVersion,
    reconcileOnLogin,
    resolveArchiveChoice,
    dismissArchiveChoice,
    practicedParts,
    masteryEntries,
    dueCount,
    gradingCounts,
    starredCount,
    excludedPartIds,
    partState,
    init,
    refresh,
    applyGrade,
    setGrading,
    setStarred,
    toUserState,
    syncNow,
    resolveConflict,
    dismissConflict,
    localChecksum,
  };
});
