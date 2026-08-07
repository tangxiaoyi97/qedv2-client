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
  GUEST_ATTEMPT_OWNER,
  overwriteServerArchive,
  performSync,
  submitResolution,
  gradingOf,
  isPartDue,
  isPracticed,
  ApiError,
  NetworkError,
  ServerClient,
  type AttemptOwnerSnapshot,
  type ArchiveContent,
  type ArchiveSideSummary,
  type QueuedAttempt,
  type FsrsState,
  type GradeResult,
  type Grading,
  type GradingOrUnseen,
  type HistoryEntry,
  type LocalArchive,
  type ServerArchiveState,
  type SyncConflict,
  type RecommendUserState,
  STORAGE,
} from '@qed2/core-logic';
import { archiveStore, attemptOutbox, historyLog, storage } from '../services.js';
import { useAppClock } from '../composables/app-clock.js';
import { runStorageMutation } from '../platform/desktop-storage.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';
  message?: string;
  at?: Date;
}

export interface AttemptUploadStatus {
  state: 'idle' | 'uploading' | 'pending' | 'error';
  pendingCount: number;
  message?: string;
}

export type SyncRunResult =
  | 'guest'
  | 'in-sync'
  | 'synced'
  | 'conflict'
  | 'blocked'
  | 'offline'
  | 'error';

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
  const clock = useAppClock();
  const archive = shallowRef<LocalArchive>({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
  const syncStatus = ref<SyncStatus>({ state: 'idle' });
  const conflict = shallowRef<SyncConflict | undefined>();
  /** Login-time archive choice (upgrade doc §2) — feeds ArchiveChoiceDialog. */
  const archiveChoice = shallowRef<ArchiveChoice | undefined>();
  const loaded = ref(false);
  /** Bumped when the history log changes so views can re-query it. */
  const historyVersion = ref(0);
  /** Bumped only after cloud attempt history may have changed. */
  const cloudHistoryVersion = ref(0);
  /** Per-account audit-upload state; the computed view follows the current account. */
  const attemptUploadByOwner = ref<Record<string, AttemptUploadStatus>>({});
  const attemptUploadStatus = computed<AttemptUploadStatus>(() => {
    const ownerId = useAuthStore().session?.user.id;
    return ownerId
      ? attemptUploadByOwner.value[ownerId] ?? { state: 'idle', pendingCount: 0 }
      : { state: 'idle', pendingCount: 0 };
  });

  /**
   * Every archive mutation is serialized through one queue. IndexedDB writes,
   * grading, manual overrides and network syncs are all asynchronous; without
   * a queue an older sync response can overwrite a grade recorded while the
   * request was in flight. Keeping the queue alive after failures also means a
   * transient network/storage error cannot permanently block later progress.
   */
  let archiveMutationTail: Promise<void> = Promise.resolve();
  const attemptFlushes: Array<{
    ownerId: string;
    token: string;
    serverBaseUrl: string;
    promise: Promise<void>;
  }> = [];
  const latestAttemptFlushByOwner = new Map<string, symbol>();
  let storageSubscribed = false;
  let archiveChoiceBase: LocalArchive | undefined;
  let conflictArchiveBase: LocalArchive | undefined;

  function enqueueArchiveMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = archiveMutationTail.then(mutation, mutation);
    archiveMutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function sameArchive(left: LocalArchive, right: LocalArchive): boolean {
    return (
      left.baseVersion === right.baseVersion &&
      archiveChecksum(left.content) === archiveChecksum(right.content)
    );
  }

  /** A short lock: storage I/O only, never a core/server request. */
  async function loadLatestArchive(): Promise<LocalArchive> {
    return runStorageMutation(storage, async () => {
      const latest = await archiveStore.load();
      archive.value = latest;
      return latest;
    });
  }

  /** Optimistic commit after a network request; never overwrites newer work. */
  async function commitArchiveIfUnchanged(
    expected: LocalArchive,
    next: LocalArchive,
  ): Promise<boolean> {
    return runStorageMutation(storage, async () => {
      const current = await archiveStore.load();
      if (!sameArchive(current, expected)) {
        archive.value = current;
        return false;
      }
      await archiveStore.save(next);
      archive.value = next;
      return true;
    });
  }

  async function archiveIsStillCurrent(expected: LocalArchive): Promise<boolean> {
    return runStorageMutation(storage, async () => {
      const current = await archiveStore.load();
      archive.value = current;
      return sameArchive(current, expected);
    });
  }

  function subscribeStorageChanges(): void {
    if (storageSubscribed || !storage.onChange) return;
    storageSubscribed = true;
    storage.onChange((change) => {
      if (change.collection === STORAGE.archive) {
        // Join the local queue as well as the origin-wide mutex: neither a
        // stale notification nor a local in-flight mutation may win later.
        void enqueueArchiveMutation(loadLatestArchive);
      }
      if (
        change.collection === STORAGE.history &&
        (change.operation === 'clear' || change.key === 'log')
      ) {
        historyVersion.value += 1;
      }
      if (change.collection === STORAGE.history && change.key === 'attempt-outbox') {
        // Other desktop renderers are notified for both enqueue and ack. An
        // early cloud read is harmless; the ack notification causes the
        // authoritative second read that removes any empty pre-upload view.
        cloudHistoryVersion.value += 1;
      }
    });
  }

  const practicedParts = computed(
    () => archive.value.content.perPart.filter((p) => isPracticed(p)).length,
  );
  const masteryEntries = computed(() =>
    archive.value.content.perCompetency.map((c) => ({ code: c.code, mastery: c.mastery })),
  );
  const dueCount = computed(() => {
    const now = clock.now.value;
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


  const excludedPartIds = computed(
    () => new Set(archive.value.content.perPart.filter((p) => p.grading === 'excluded').map((p) => p.partId)),
  );

  async function init(): Promise<void> {
    subscribeStorageChanges();
    archive.value = await loadLatestArchive();
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    await enqueueArchiveMutation(loadLatestArchive);
  }

  function setAttemptUploadStatus(
    ownerId: string,
    runId: symbol,
    status: AttemptUploadStatus,
  ): void {
    if (latestAttemptFlushByOwner.get(ownerId) !== runId) return;
    attemptUploadByOwner.value = { ...attemptUploadByOwner.value, [ownerId]: status };
  }

  function sameAttemptSession(snapshot: { ownerId: string; token: string }): boolean {
    const current = useAuthStore().session;
    return current?.user.id === snapshot.ownerId && current.token === snapshot.token;
  }

  /**
   * Flush only the account captured at invocation. Both owner and token are
   * snapshotted: a cross-window account switch can neither redirect an old
   * batch to the new token nor acknowledge/delete it under the wrong session.
   * Separate snapshots have separate promises, so B never reuses A's flush.
   */
  async function flushAttemptOutbox(): Promise<void> {
    const auth = useAuthStore();
    const current = auth.session;
    if (!current) return;
    const app = useAppStore();
    const snapshot = {
      ownerId: current.user.id,
      token: current.token,
      serverBaseUrl: app.config.serverBaseUrl,
    };
    const existing = attemptFlushes.find(
      (entry) =>
        entry.ownerId === snapshot.ownerId &&
        entry.token === snapshot.token &&
        entry.serverBaseUrl === snapshot.serverBaseUrl,
    );
    if (existing) return existing.promise;

    const runId = Symbol(snapshot.ownerId);
    latestAttemptFlushByOwner.set(snapshot.ownerId, runId);
    const client = new ServerClient(snapshot.serverBaseUrl, () => snapshot.token);

    const promise = (async () => {
      for (;;) {
        const pendingCount = await attemptOutbox.count(snapshot.ownerId);
        if (pendingCount === 0) {
          setAttemptUploadStatus(snapshot.ownerId, runId, { state: 'idle', pendingCount: 0 });
          return;
        }
        if (!sameAttemptSession(snapshot)) {
          setAttemptUploadStatus(snapshot.ownerId, runId, {
            state: 'pending',
            pendingCount,
            message: 'Der Antwortverlauf wartet auf die nächste Anmeldung dieses Kontos.',
          });
          return;
        }

        const pending = await attemptOutbox.list(snapshot.ownerId, 500);
        if (pending.length === 0) continue;
        setAttemptUploadStatus(snapshot.ownerId, runId, {
          state: 'uploading',
          pendingCount,
          message: 'Antwortverlauf wird hochgeladen …',
        });

        try {
          await client.recordAttempts(pending);
          // The response may have committed just before an account/token
          // switch. Keep the local ids in that case; an idempotent retry under
          // the matching session is safer than deleting unacknowledged work.
          if (!sameAttemptSession(snapshot)) {
            setAttemptUploadStatus(snapshot.ownerId, runId, {
              state: 'pending',
              pendingCount: await attemptOutbox.count(snapshot.ownerId),
              message: 'Der Antwortverlauf wartet auf die nächste Anmeldung dieses Kontos.',
            });
            return;
          }

          let removed = false;
          await runStorageMutation(storage, async () => {
            if (!sameAttemptSession(snapshot)) return;
            await attemptOutbox.remove(
              snapshot.ownerId,
              pending.map((attempt) => attempt.clientAttemptId),
            );
            removed = true;
          });
          if (!removed) {
            setAttemptUploadStatus(snapshot.ownerId, runId, {
              state: 'pending',
              pendingCount: await attemptOutbox.count(snapshot.ownerId),
              message: 'Der Antwortverlauf wartet auf die nächste Anmeldung dieses Kontos.',
            });
            return;
          }
          cloudHistoryVersion.value += 1;
        } catch (error) {
          const count = await attemptOutbox.count(snapshot.ownerId);
          const offline = error instanceof NetworkError;
          setAttemptUploadStatus(snapshot.ownerId, runId, {
            state: offline ? 'pending' : 'error',
            pendingCount: count,
            message: offline
              ? `${count} ${count === 1 ? 'Antwort wartet' : 'Antworten warten'} auf eine Verbindung.`
              : error instanceof ApiError && error.status === 401
                ? 'Der Antwortverlauf wartet auf eine erneute Anmeldung.'
                : 'Der Antwortverlauf konnte nicht hochgeladen werden. Bitte erneut versuchen.',
          });
          return;
        }
      }
    })();

    const entry = { ...snapshot, promise };
    attemptFlushes.push(entry);
    try {
      await promise;
    } finally {
      const index = attemptFlushes.indexOf(entry);
      if (index >= 0) attemptFlushes.splice(index, 1);
    }
  }

  /**
   * Capture answer/session ownership once. A guest capture also fixes the
   * current guest generation, allowing a concurrent invite claim to route
   * this already-open session while leaving later guest sessions untouched.
   */
  async function captureAttemptOwner(): Promise<AttemptOwnerSnapshot> {
    const userId = useAuthStore().session?.user.id;
    if (userId) return { userId };
    return runStorageMutation(storage, () => attemptOutbox.captureGuestOwner());
  }

  /**
   * Durable write-ahead step for one graded event. Practice calls this before
   * mutating archive/history/session state, so a renderer crash after any later
   * await still leaves an idempotent audit record that registration can claim.
   */
  async function stageAttempt(
    attempt: QueuedAttempt,
    capturedOwner?: string | AttemptOwnerSnapshot,
  ): Promise<string> {
    const owner = capturedOwner ?? await captureAttemptOwner();
    return runStorageMutation(storage, () => attemptOutbox.enqueue(owner, attempt));
  }

  /** Upload only when the staged owner is still the active authenticated user. */
  async function flushStagedAttempt(userId: string): Promise<void> {
    const auth = useAuthStore();
    // The resolved owner may have been fixed or guest-routed before later
    // archive/history/session writes. Never flush it through a different
    // account that appeared while those awaits were in flight.
    if (userId !== GUEST_ATTEMPT_OWNER && auth.session?.user.id === userId) {
      await flushAttemptOutbox();
    }
  }

  /** Convenience path for callers that do not need a multi-step local commit. */
  async function queueAttempt(
    attempt: QueuedAttempt,
    capturedOwner?: string | AttemptOwnerSnapshot,
  ): Promise<void> {
    const userId = await stageAttempt(attempt, capturedOwner);
    await flushStagedAttempt(userId);
  }

  /** Persisted before an invite-created session is committed. */
  async function beginGuestAttemptClaim(userId: string): Promise<void> {
    await runStorageMutation(storage, () => attemptOutbox.beginGuestClaim(userId));
  }

  /**
   * Recover only a marker naming this exact account. Ordinary login/init can
   * safely call this: guest data without a matching invite marker is ignored.
   */
  async function recoverGuestAttemptClaim(userId: string): Promise<number> {
    return runStorageMutation(storage, async () => {
      if ((await attemptOutbox.pendingGuestClaim()) !== userId) return 0;
      const claimed = await attemptOutbox.claim(GUEST_ATTEMPT_OWNER, userId);
      await attemptOutbox.finishGuestClaim(userId);
      return claimed;
    });
  }

  /** Registration helper retained for direct callers/tests. */
  async function claimGuestAttempts(userId: string): Promise<number> {
    await beginGuestAttemptClaim(userId);
    return recoverGuestAttemptClaim(userId);
  }

  /** Per-part progress lookup for browse/list views. */
  const partState = computed(() => {
    const map = new Map<string, PartStateView>();
    const now = clock.now.value;
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
    /** One event timestamp shared by archive, local history and cloud outbox. */
    gradedAt?: string;
  }): Promise<{ grading: Grading; previousFsrs: FsrsState | undefined }> {
    return enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      const parsed = input.gradedAt ? new Date(input.gradedAt) : new Date();
      const now = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      const res = await archiveStore.applyGrade({
        partId: input.partId,
        competencyCodes: input.competencyCodes,
        verdict: input.result.verdict,
        awardedPoints: input.result.awardedPoints,
        maxPoints: input.result.maxPoints,
        now,
      });
      archive.value = res.archive;
      const entry: HistoryEntry = {
        partId: input.partId,
        questionId: input.questionId,
        verdict: input.result.verdict,
        awardedPoints: input.result.awardedPoints,
        maxPoints: input.result.maxPoints,
        grading: res.grading,
        gradedAt: now.toISOString(),
      };
      if (input.elapsedMs !== undefined) entry.elapsedMs = input.elapsedMs;
      await historyLog.append(entry);
      historyVersion.value += 1;
      return { grading: res.grading, previousFsrs: res.previousFsrs };
    }));
  }

  /** Manual grading (menu) — always overrides; see ArchiveStore.setGrading. */
  async function setGrading(input: {
    partId: string;
    grading: Grading;
    baseFsrs?: FsrsState | undefined;
  }): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      archive.value = await archiveStore.setGrading({
        partId: input.partId,
        grading: input.grading,
        now: new Date(),
        baseFsrs: input.baseFsrs,
      });
    }));
  }

  async function setStarred(partId: string, starred: boolean): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      archive.value = await archiveStore.setStarred(partId, starred, new Date());
    }));
  }

  async function toUserState(): Promise<RecommendUserState> {
    return runStorageMutation(storage, async () => {
      archive.value = await archiveStore.load();
      return archiveStore.toUserState();
    });
  }

  /**
   * Run one sync round. Guests and offline users no-op gracefully.
   * On conflict the dialog state is populated; resolution happens via
   * resolveConflict().
   */
  async function runSyncRound(opts: { quiet: boolean; compareChecksum?: boolean }): Promise<SyncRunResult> {
    const auth = useAuthStore();
    const app = useAppStore();
    if (!auth.isLoggedIn) return 'guest';
    syncStatus.value = { state: 'syncing' };
    try {
      // Another renderer may grade while this renderer is awaiting the
      // server. Snapshot and commit are tiny lock sections; the network is
      // deliberately outside the lock. A changed snapshot retries against
      // the already-advanced server instead of overwriting newer local work.
      for (let contentionAttempt = 0; contentionAttempt < 4; contentionAttempt += 1) {
        const local = await loadLatestArchive();
        const serverState = opts.compareChecksum ? await app.serverClient.getState() : undefined;
        const { outcome, archive: next } = await performSync(
          app.serverClient,
          local,
          serverState
            ? {
                serverChecksumHint: serverState.checksum,
                serverVersionHint: serverState.archiveVersion,
              }
            : undefined,
        );
        if (outcome.type === 'conflict') {
          if (!(await archiveIsStillCurrent(local))) continue;
          conflict.value = outcome.conflict;
          conflictArchiveBase = local;
          syncStatus.value = { state: 'conflict', at: new Date() };
          return 'conflict';
        }
        if (!(await commitArchiveIfUnchanged(local, next))) continue;
        conflictArchiveBase = undefined;
        syncStatus.value = { state: 'synced', at: new Date() };
        return outcome.type === 'in-sync' ? 'in-sync' : 'synced';
      }
      syncStatus.value = {
        state: 'idle',
        message: 'Lokaler Fortschritt wurde parallel aktualisiert; Synchronisierung wird später wiederholt.',
        at: new Date(),
      };
      return 'blocked';
    } catch (e) {
      if (e instanceof NetworkError) {
        syncStatus.value = { state: 'offline', at: new Date() };
        return 'offline';
      } else if (e instanceof ApiError && e.status === 401) {
        syncStatus.value = { state: 'error', message: 'Anmeldung abgelaufen — bitte neu anmelden.', at: new Date() };
        return 'error';
      } else {
        syncStatus.value = { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
        if (!opts.quiet) throw e;
        return 'error';
      }
    }
  }

  async function syncNow(opts: { quiet: boolean; compareChecksum?: boolean }): Promise<SyncRunResult> {
    return enqueueArchiveMutation(() => runSyncRound(opts));
  }

  /**
   * Contract §8.2: recommendations may use the local archive only after its
   * checksum has been compared with the cloud. A pending archive choice or
   * true conflict blocks recommendation; offline/error states deliberately do
   * not, because local practice remains available without the user server.
   */
  async function syncBeforeRecommendation(): Promise<SyncRunResult> {
    return enqueueArchiveMutation(async () => {
      const auth = useAuthStore();
      if (!auth.isLoggedIn) return 'guest';
      if (archiveChoice.value || conflict.value) return 'blocked';
      return runSyncRound({ quiet: true, compareChecksum: true });
    });
  }

  /**
   * ONE-TIME login reconciliation (upgrade doc §2.2). Quiet cases resolve
   * silently; only "both sides differ" opens the choice dialog. Network
   * failure degrades to the offline state — the user continues locally.
   */
  async function reconcileOnLoginUnlocked(): Promise<void> {
    const app = useAppStore();
    syncStatus.value = { state: 'syncing' };
    try {
      for (let contentionAttempt = 0; contentionAttempt < 4; contentionAttempt += 1) {
        const local = await loadLatestArchive();
        const serverState = await app.serverClient.getState();
        const assessment = assessLoginArchives(local, serverState);
        switch (assessment.kind) {
          case 'adopt-server':
          case 'in-sync':
            if (!(await commitArchiveIfUnchanged(local, assessment.archive))) continue;
            syncStatus.value = { state: 'synced', at: new Date() };
            return;
          case 'upload-local': {
            // Empty cloud archive — a plain sync from the server's version
            // fast-forwards the local content up (no data on either side lost).
            const { outcome, archive: next } = await performSync(app.serverClient, {
              content: local.content,
              baseVersion: assessment.baseVersion,
            });
            if (outcome.type === 'conflict') {
              if (!(await archiveIsStillCurrent(local))) continue;
              conflict.value = outcome.conflict;
              conflictArchiveBase = local;
              syncStatus.value = { state: 'conflict', at: new Date() };
              return;
            }
            if (!(await commitArchiveIfUnchanged(local, next))) continue;
            syncStatus.value = { state: 'synced', at: new Date() };
            return;
          }
          case 'choice-needed':
            if (!(await archiveIsStillCurrent(local))) continue;
            archiveChoice.value = {
              serverState: assessment.serverState,
              server: assessment.server,
              local: assessment.local,
            };
            archiveChoiceBase = local;
            syncStatus.value = { state: 'idle' };
            return;
        }
      }
      syncStatus.value = {
        state: 'idle',
        message: 'Lokaler Fortschritt wurde parallel aktualisiert; der Kontoabgleich wird später wiederholt.',
        at: new Date(),
      };
    } catch (e) {
      syncStatus.value =
        e instanceof NetworkError
          ? { state: 'offline', at: new Date() }
          : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
    }
  }

  async function reconcileOnLogin(): Promise<void> {
    await enqueueArchiveMutation(reconcileOnLoginUnlocked);
  }

  /** The user's pick in the archive-choice dialog (§2.3). */
  async function resolveArchiveChoice(pick: 'merge' | 'server' | 'local'): Promise<void> {
    const app = useAppStore();
    const choice = archiveChoice.value;
    const expected = archiveChoiceBase;
    if (!choice || !expected) return;
    try {
      if (pick === 'server') {
        const adopted: LocalArchive = {
          content: canonicalizeArchive({
            perPart: choice.serverState.perPart,
            perCompetency: choice.serverState.perCompetency,
          }),
          baseVersion: choice.serverState.archiveVersion,
        };
        if (!(await commitArchiveIfUnchanged(expected, adopted))) {
          archiveChoice.value = undefined;
          archiveChoiceBase = undefined;
          await reconcileOnLogin();
          return;
        }
        syncStatus.value = { state: 'synced', at: new Date() };
      } else if (pick === 'local') {
        const { outcome, archive: next } = await overwriteServerArchive(
          app.serverClient,
          choice.serverState.archiveVersion,
          expected.content,
        );
        if (outcome.type === 'conflict') {
          // Another device wrote while choosing — re-run the assessment.
          archiveChoice.value = undefined;
          archiveChoiceBase = undefined;
          await reconcileOnLogin();
          return;
        }
        if (next && !(await commitArchiveIfUnchanged(expected, next))) {
          archiveChoice.value = undefined;
          archiveChoiceBase = undefined;
          await reconcileOnLogin();
          return;
        }
        syncStatus.value = { state: 'synced', at: new Date() };
      } else {
        // merge — the recommended path: a regular contract-§5 sync round;
        // a true conflict falls through to the per-entry conflict dialog.
        archiveChoice.value = undefined;
        await syncNow({ quiet: false });
      }
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
    } catch (e) {
      syncStatus.value =
        e instanceof NetworkError
          ? { state: 'offline', at: new Date() }
          : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
    }
  }

  /** Postponing is allowed — the next login re-offers the choice (§2.4). */
  function dismissArchiveChoice(): void {
    archiveChoice.value = undefined;
    archiveChoiceBase = undefined;
    syncStatus.value = { state: 'idle' };
  }

  /** User picked sides in the conflict dialog. */
  async function resolveConflict(choices: Record<string, 'server' | 'local'>): Promise<void> {
    await enqueueArchiveMutation(async () => {
      const app = useAppStore();
      const current = conflict.value;
      const expected = conflictArchiveBase;
      if (!current || !expected) return;
      const resolved: ArchiveContent = buildResolvedArchive(current, choices);
      const { outcome, archive: next } = await submitResolution(app.serverClient, current, resolved);
      if (outcome.type === 'conflict') {
        // Another device wrote while the user was choosing — new round.
        if (!(await archiveIsStillCurrent(expected))) {
          conflict.value = undefined;
          conflictArchiveBase = undefined;
          await runSyncRound({ quiet: true });
          return;
        }
        conflict.value = outcome.conflict;
        conflictArchiveBase = expected;
        return;
      }
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      if (next) {
        if (!(await commitArchiveIfUnchanged(expected, next))) {
          await runSyncRound({ quiet: true });
          return;
        }
      }
      syncStatus.value = { state: 'synced', at: new Date() };
    });
  }

  function dismissConflict(): void {
    // Allowed: the user can postpone; local progress keeps accumulating and
    // the next sync will re-surface the conflict.
    conflict.value = undefined;
    conflictArchiveBase = undefined;
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
    cloudHistoryVersion,
    attemptUploadStatus,
    reconcileOnLogin,
    resolveArchiveChoice,
    dismissArchiveChoice,
    practicedParts,
    masteryEntries,
    dueCount,
    gradingCounts,
    excludedPartIds,
    partState,
    init,
    refresh,
    captureAttemptOwner,
    stageAttempt,
    flushStagedAttempt,
    queueAttempt,
    beginGuestAttemptClaim,
    recoverGuestAttemptClaim,
    claimGuestAttempts,
    flushAttemptOutbox,
    applyGrade,
    setGrading,
    setStarred,
    toUserState,
    syncNow,
    syncBeforeRecommendation,
    resolveConflict,
    dismissConflict,
    localChecksum,
  };
});
