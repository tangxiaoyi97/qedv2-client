/**
 * Progress store: reactive view over the local archive + the sync loop +
 * the grading system (grading supplement). All computation (FSRS, mastery,
 * checksum, merge dispatch, grading→FSRS mapping) lives in @qed2/core-logic —
 * this store only binds it to the UI.
 */
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import {
  archiveChecksum,
  accountStorageIdentity,
  ATTEMPT_OUTBOX_ROW_PREFIX,
  assessLoginArchives,
  buildResolvedArchive,
  canonicalizeArchive,
  canonicalServiceBaseUrl,
  AMBIGUOUS_GUEST_ATTEMPT_OWNER,
  GUEST_ATTEMPT_OWNER,
  HISTORY_EVENT_ROW_PREFIX,
  LOCAL_PROFILE_STATE_KEY,
  overwriteServerArchive,
  performSync,
  submitResolution,
  gradingOf,
  isPartDue,
  isPracticed,
  ApiError,
  ArchiveStore,
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
  type LocalProfileId,
  type RegistrationIntent,
  type LocalGradeSessionMutation,
  type ServerArchiveState,
  type SyncConflict,
  type RecommendUserState,
  type CoreSourcePreference,
  STORAGE,
  userLocalProfileId,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  historyLog,
  localGradeCommitStore,
  learningEventStore,
  localProfileStore,
  registrationJournal,
  storage,
  syncMutationJournal,
} from '../services.js';
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
    const ownerId = localAccountOwner(useAuthStore().session);
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
  let archiveChoiceContext: AccountArchiveContext | undefined;
  let archiveChoicePendingPick: 'merge' | 'server' | 'local' | undefined;
  let conflictArchiveBase: LocalArchive | undefined;
  let conflictContext: AccountArchiveContext | undefined;
  let cloudRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let cloudRecoveryAttempt = 0;
  let cloudRecoveryGeneration = 0;
  const CLOUD_RECOVERY_DELAYS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

  interface AccountArchiveContext {
    remoteUserId: string;
    ownerId: string;
    token: string;
    serverBaseUrl: string;
    profileId: LocalProfileId;
  }

  interface CloudRecoveryContext extends AccountArchiveContext {
    generation: number;
  }

  function isTransientCloudError(error: unknown): boolean {
    return error instanceof NetworkError
      || (error instanceof ApiError && (error.status === 429 || error.status >= 500));
  }

  function resetCloudRecovery(): void {
    cloudRecoveryAttempt = 0;
    if (cloudRecoveryTimer !== undefined) globalThis.clearTimeout(cloudRecoveryTimer);
    cloudRecoveryTimer = undefined;
  }

  /**
   * Invalidate both a pending timer and a callback that has already started.
   * Clearing a timeout alone is insufficient: its detached async body may be
   * between awaits while another window logs in a different account.
   */
  function cancelCloudRecovery(): void {
    cloudRecoveryGeneration += 1;
    resetCloudRecovery();
  }

  function captureCloudRecoveryContext(): CloudRecoveryContext | undefined {
    const current = captureAccountArchiveContext();
    return current ? {
      ...current,
      generation: cloudRecoveryGeneration,
    } : undefined;
  }

  function isCurrentCloudRecoveryContext(context: CloudRecoveryContext): boolean {
    return (
      context.generation === cloudRecoveryGeneration &&
      isCurrentAccountArchiveContext(context)
    );
  }

  /**
   * navigator/net.isOnline cannot detect a reachable Wi-Fi link whose server
   * is down. A bounded, jittered retry therefore continues without requiring
   * a false→true platform event. Server writes remain idempotent.
   */
  function scheduleCloudRecovery(immediate = false): void {
    if (cloudRecoveryTimer !== undefined) return;
    const context = captureCloudRecoveryContext();
    if (!context) return;
    const base = immediate
      ? 0
      : CLOUD_RECOVERY_DELAYS[Math.min(cloudRecoveryAttempt, CLOUD_RECOVERY_DELAYS.length - 1)]!;
    const delay = base === 0 ? 0 : Math.round(base * (0.85 + Math.random() * 0.3));
    cloudRecoveryAttempt += 1;
    cloudRecoveryTimer = globalThis.setTimeout(() => {
      cloudRecoveryTimer = undefined;
      const recovery = (async () => {
        const app = useAppStore();
        if (!isCurrentCloudRecoveryContext(context)) return;
        if (!app.online) {
          scheduleCloudRecovery();
          return;
        }
        await flushAttemptOutbox(context);
        if (!isCurrentCloudRecoveryContext(context)) return;
        if (
          archiveChoicePendingPick
          && archiveChoiceContext
          && isCurrentAccountArchiveContext(archiveChoiceContext)
          && archiveChoiceContext.ownerId === context.ownerId
          && archiveChoiceContext.profileId === context.profileId
        ) {
          await resolveArchiveChoice(archiveChoicePendingPick);
        } else {
          await syncNowForRecovery(context);
        }
        if (!isCurrentCloudRecoveryContext(context)) return;
        const retryAttempt = attemptUploadByOwner.value[context.ownerId]?.state === 'pending';
        const retrySync = syncStatus.value.state === 'offline';
        if (retryAttempt || retrySync) scheduleCloudRecovery();
        else resetCloudRecovery();
      })();
      // Timer callbacks are detached by design. Storage/SQLite failures are
      // therefore terminally caught here and retried with the same bounded
      // backoff only while the exact account context is still current.
      void recovery.catch(() => {
        if (isCurrentCloudRecoveryContext(context)) scheduleCloudRecovery();
      });
    }, delay);
    const nodeTimer = cloudRecoveryTimer as unknown as { unref?: () => void };
    nodeTimer.unref?.();
  }

  onScopeDispose(cancelCloudRecovery);

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

  function localAccountOwner(
    current: { user: { id: string }; serverBaseUrl?: string } | undefined,
  ): string | undefined {
    if (!current) return undefined;
    // Directly injected sessions exist only in isolated store tests. Durable
    // production sessions are upgraded with an issuer before publication.
    if (!current.serverBaseUrl) return current.user.id;
    const configured = canonicalServiceBaseUrl(useAppStore().config.serverBaseUrl);
    const issuer = canonicalServiceBaseUrl(current.serverBaseUrl);
    if (issuer !== configured) return undefined;
    return accountStorageIdentity(issuer, current.user.id);
  }

  function captureAccountArchiveContext(): AccountArchiveContext | undefined {
    const current = useAuthStore().session;
    const profileId = localProfileStore.currentIfInitialized();
    const ownerId = localAccountOwner(current);
    if (!current || !ownerId || !profileId || profileId !== userLocalProfileId(ownerId)) {
      return undefined;
    }
    return {
      remoteUserId: current.user.id,
      ownerId,
      token: current.token,
      serverBaseUrl: useAppStore().config.serverBaseUrl,
      profileId,
    };
  }

  function isCurrentAccountArchiveContext(context: AccountArchiveContext): boolean {
    const current = useAuthStore().session;
    return current?.user.id === context.remoteUserId
      && localAccountOwner(current) === context.ownerId
      && current.token === context.token
      && useAppStore().config.serverBaseUrl === context.serverBaseUrl
      && localProfileStore.currentIfInitialized() === context.profileId;
  }

  function isSameAccountArchiveContext(
    left: AccountArchiveContext,
    right: AccountArchiveContext,
  ): boolean {
    return left.ownerId === right.ownerId
      && left.remoteUserId === right.remoteUserId
      && left.token === right.token
      && left.serverBaseUrl === right.serverBaseUrl
      && left.profileId === right.profileId;
  }

  function clearConflictForContext(context: AccountArchiveContext): void {
    if (!conflictContext || !isSameAccountArchiveContext(conflictContext, context)) return;
    conflict.value = undefined;
    conflictArchiveBase = undefined;
    conflictContext = undefined;
  }

  function clientForContext(context: AccountArchiveContext): ServerClient {
    return new ServerClient(context.serverBaseUrl, () => context.token);
  }

  function archiveForContext(context: AccountArchiveContext): ArchiveStore {
    return new ArchiveStore(storage, context.profileId);
  }

  function syncFingerprint(local: LocalArchive): string {
    return `v1-${local.baseVersion}-${archiveChecksum(local.content)}`;
  }

  function resolveFingerprint(serverVersion: number, content: ArchiveContent): string {
    return `v1-${serverVersion}-${archiveChecksum(canonicalizeArchive(content))}`;
  }

  function mutationScope(context: AccountArchiveContext) {
    return { serverBaseUrl: context.serverBaseUrl, userId: context.remoteUserId };
  }

  async function performJournaledSync(
    client: ServerClient,
    context: AccountArchiveContext,
    local: LocalArchive,
    hints?: { serverChecksumHint?: string; serverVersionHint?: number },
  ) {
    if (
      hints?.serverChecksumHint !== undefined
      && hints.serverVersionHint !== undefined
      && hints.serverChecksumHint === archiveChecksum(local.content)
    ) {
      return {
        ...await performSync(client, local, hints),
        journal: undefined,
      };
    }
    const fingerprint = syncFingerprint(local);
    const record = await syncMutationJournal.getOrCreate(mutationScope(context), {
      operation: 'sync',
      fingerprint,
      baseVersion: local.baseVersion,
      localArchive: local.content,
    });
    const result = await performSync(client, local, {
      ...hints,
      clientMutationId: record.clientMutationId,
    });
    return { ...result, journal: record };
  }

  async function submitJournaledResolution(
    client: ServerClient,
    context: AccountArchiveContext,
    serverVersion: number,
    content: ArchiveContent,
    expected: LocalArchive,
    submit: (clientMutationId: string) => ReturnType<typeof submitResolution>,
  ) {
    const fingerprint = resolveFingerprint(serverVersion, content);
    const record = await syncMutationJournal.getOrCreate(mutationScope(context), {
      operation: 'resolve',
      fingerprint,
      baseServerVersion: serverVersion,
      resolvedArchive: content,
      expectedLocalFingerprint: syncFingerprint(expected),
    });
    const result = await submit(record.clientMutationId);
    return { ...result, journal: record };
  }

  async function completeJournal(
    context: AccountArchiveContext,
    record: {
      operation: 'sync' | 'resolve';
      fingerprint: string;
      clientMutationId: string;
    } | undefined,
  ): Promise<void> {
    if (!record) return;
    await syncMutationJournal.complete(
      mutationScope(context),
      record.operation,
      record.fingerprint,
      record.clientMutationId,
    );
  }

  /** Replay durable response-ambiguous writes before creating any newer one. */
  async function recoverPendingMutations(
    context: AccountArchiveContext,
  ): Promise<'conflict' | 'blocked' | 'recovered' | undefined> {
    const records = await syncMutationJournal.listPending(mutationScope(context));
    if (records.length === 0) return undefined;
    const client = clientForContext(context);
    for (const record of records) {
      if (!isCurrentAccountArchiveContext(context)) return 'blocked';
      if (record.operation === 'sync') {
        const result = await performSync(client, {
          baseVersion: record.intent.baseVersion,
          content: record.intent.localArchive,
        }, { clientMutationId: record.clientMutationId });
        if (!isCurrentAccountArchiveContext(context)) return 'blocked';
        const latest = await loadLatestArchive(context);
        const stillExpected = syncFingerprint(latest) === record.fingerprint;
        if (result.outcome.type === 'conflict') {
          await completeJournal(context, record);
          continue;
        }
        if (stillExpected) {
          await commitArchiveIfUnchanged(latest, result.archive, context);
        }
        await completeJournal(context, record);
        continue;
      }

      const result = await overwriteServerArchive(
        client,
        record.intent.baseServerVersion,
        record.intent.resolvedArchive,
        record.clientMutationId,
      );
      if (!isCurrentAccountArchiveContext(context)) return 'blocked';
      const latest = await loadLatestArchive(context);
      const stillExpected = syncFingerprint(latest) === record.intent.expectedLocalFingerprint;
      if (result.outcome.type === 'conflict') {
        await completeJournal(context, record);
        continue;
      }
      if (stillExpected && result.archive) {
        await commitArchiveIfUnchanged(latest, result.archive, context);
      }
      await completeJournal(context, record);
    }

    // Receipt creation order is not server commit order: two renderers can
    // submit F1/F2 concurrently and F2 may arrive first. A read-only state
    // check after draining receipts is the only authoritative way to decide
    // whether another POST is necessary. It also calibrates baseVersion
    // without incrementing the archive again.
    if (!isCurrentAccountArchiveContext(context)) return 'blocked';
    const serverState = await client.getState();
    if (!isCurrentAccountArchiveContext(context)) return 'blocked';
    const serverContent = canonicalizeArchive({
      perPart: serverState.perPart,
      perCompetency: serverState.perCompetency,
    });
    if (archiveChecksum(serverContent) !== serverState.checksum) {
      throw new Error('Server archive checksum does not match its content');
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const latest = await loadLatestArchive(context);
      if (archiveChecksum(latest.content) !== serverState.checksum) return undefined;
      if (latest.baseVersion !== serverState.archiveVersion) {
        const calibrated = { content: latest.content, baseVersion: serverState.archiveVersion };
        if (!(await commitArchiveIfUnchanged(latest, calibrated, context))) continue;
      }
      if (!isCurrentAccountArchiveContext(context)) return 'blocked';
      // A replayed resolution can be the response to the conflict dialog
      // that is still open after a renderer/network interruption. Clear only
      // state owned by this exact account epoch; never dismiss a newer
      // account's conflict.
      clearConflictForContext(context);
      syncStatus.value = { state: 'synced', at: new Date() };
      return 'recovered';
    }
    return undefined;
  }

  /** A short lock: storage I/O only, never a core/server request. */
  async function loadLatestArchive(context?: AccountArchiveContext): Promise<LocalArchive> {
    return runStorageMutation(storage, async () => {
      const latest = await (context ? archiveForContext(context) : archiveStore).load();
      if (!context || isCurrentAccountArchiveContext(context)) archive.value = latest;
      return latest;
    });
  }

  /** Optimistic commit after a network request; never overwrites newer work. */
  async function commitArchiveIfUnchanged(
    expected: LocalArchive,
    next: LocalArchive,
    context?: AccountArchiveContext,
  ): Promise<boolean> {
    return runStorageMutation(storage, async () => {
      const target = context ? archiveForContext(context) : archiveStore;
      const committed = await target.saveIfUnchanged(expected, next);
      const latest = committed ? next : await target.load();
      if (!context || isCurrentAccountArchiveContext(context)) archive.value = latest;
      return committed;
    });
  }

  async function archiveIsStillCurrent(
    expected: LocalArchive,
    context?: AccountArchiveContext,
  ): Promise<boolean> {
    return runStorageMutation(storage, async () => {
      const current = await (context ? archiveForContext(context) : archiveStore).load();
      if (!context || isCurrentAccountArchiveContext(context)) archive.value = current;
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
        void enqueueArchiveMutation(async () => {
          if (change.key === 'current') await localProfileStore.refresh();
          await loadLatestArchive();
        }).catch(() => undefined);
      }
      if (change.collection === STORAGE.app && change.key === LOCAL_PROFILE_STATE_KEY) {
        void enqueueArchiveMutation(async () => {
          await localProfileStore.refresh();
          await loadLatestArchive();
          historyVersion.value += 1;
        }).catch(() => undefined);
      }
      if (
        change.collection === STORAGE.history &&
        (
          change.operation === 'clear'
          || change.key === 'log'
          || change.key?.startsWith(HISTORY_EVENT_ROW_PREFIX)
        )
      ) {
        if (change.key === 'log') {
          void enqueueArchiveMutation(async () => {
            await localProfileStore.refresh();
            await loadLatestArchive();
          }).catch(() => undefined);
        }
        historyVersion.value += 1;
      }
      if (
        change.collection === STORAGE.history
        && (change.key === 'attempt-outbox' || change.key?.startsWith(ATTEMPT_OUTBOX_ROW_PREFIX))
      ) {
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
    if (localProfileStore.currentIfInitialized()) {
      await localProfileStore.refresh().catch(async () => {
        await runStorageMutation(storage, () => localProfileStore.initialize());
      });
    } else {
      await runStorageMutation(storage, () => localProfileStore.initialize());
    }
    archive.value = await loadLatestArchive();
    loaded.value = true;
  }

  async function refresh(): Promise<void> {
    await enqueueArchiveMutation(loadLatestArchive);
  }

  async function activateUserProfile(userId: string): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      await localProfileStore.activateUser(userId);
      archive.value = await archiveStore.load();
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      conflictContext = undefined;
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
      archiveChoiceContext = undefined;
      historyVersion.value += 1;
    }));
  }

  async function activateGuestProfile(): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      await localProfileStore.activateGuest();
      archive.value = await archiveStore.load();
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      conflictContext = undefined;
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
      archiveChoiceContext = undefined;
      syncStatus.value = { state: 'idle' };
      historyVersion.value += 1;
    }));
  }

  async function claimGuestProfile(
    userId: string,
    expectedGuestProfileId?: LocalProfileId,
    expectedGuestGeneration?: string,
  ): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      await localProfileStore.claimGuestForUser(
        userId,
        expectedGuestProfileId,
        expectedGuestGeneration,
      );
      archive.value = await archiveStore.load();
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      conflictContext = undefined;
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
      archiveChoiceContext = undefined;
      historyVersion.value += 1;
    }));
  }

  /** Resume only an invite marker naming this exact account. */
  async function activateProfileForAuth(userId: string): Promise<void> {
    const pending = await attemptOutbox.pendingGuestClaim();
    if (pending === userId) await claimGuestProfile(userId);
    else await activateUserProfile(userId);
  }

  function setAttemptUploadStatus(
    ownerId: string,
    runId: symbol,
    status: AttemptUploadStatus,
  ): void {
    if (latestAttemptFlushByOwner.get(ownerId) !== runId) return;
    attemptUploadByOwner.value = { ...attemptUploadByOwner.value, [ownerId]: status };
  }

  function sameAttemptSession(snapshot: {
    ownerId: string;
    token: string;
    serverBaseUrl: string;
  }): boolean {
    const current = useAuthStore().session;
    return localAccountOwner(current) === snapshot.ownerId
      && current?.token === snapshot.token
      && useAppStore().config.serverBaseUrl === snapshot.serverBaseUrl;
  }

  /**
   * Flush only the account captured at invocation. Both owner and token are
   * snapshotted: a cross-window account switch can neither redirect an old
   * batch to the new token nor acknowledge/delete it under the wrong session.
   * Separate snapshots have separate promises, so B never reuses A's flush.
   */
  async function flushAttemptOutbox(expectedRecovery?: CloudRecoveryContext): Promise<void> {
    if (expectedRecovery && !isCurrentCloudRecoveryContext(expectedRecovery)) return;
    const auth = useAuthStore();
    const current = auth.session;
    if (!current) return;
    const app = useAppStore();
    const ownerId = localAccountOwner(current);
    if (!ownerId) return;
    const snapshot = {
      ownerId,
      token: current.token,
      serverBaseUrl: app.config.serverBaseUrl,
    };
    if (
      expectedRecovery &&
      (snapshot.ownerId !== expectedRecovery.ownerId ||
        snapshot.token !== expectedRecovery.token ||
        snapshot.serverBaseUrl !== expectedRecovery.serverBaseUrl)
    ) {
      return;
    }
    if (!app.online) {
      const pendingCount = await attemptOutbox.count(snapshot.ownerId);
      attemptUploadByOwner.value = {
        ...attemptUploadByOwner.value,
        [snapshot.ownerId]: {
          state: 'pending',
          pendingCount,
          message: `${pendingCount} ${pendingCount === 1 ? 'Antwort wartet' : 'Antworten warten'} auf eine Verbindung.`,
        },
      };
      scheduleCloudRecovery();
      return;
    }
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
          const retryable = isTransientCloudError(error);
          setAttemptUploadStatus(snapshot.ownerId, runId, {
            state: retryable ? 'pending' : 'error',
            pendingCount: count,
            message: retryable
              ? `${count} ${count === 1 ? 'Antwort wartet' : 'Antworten warten'} auf eine Verbindung.`
              : error instanceof ApiError && error.status === 401
                ? 'Der Antwortverlauf wartet auf eine erneute Anmeldung.'
                : 'Der Antwortverlauf konnte nicht hochgeladen werden. Bitte erneut versuchen.',
          });
          if (retryable) scheduleCloudRecovery();
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
    return runStorageMutation(storage, async () => {
      // BroadcastChannel may be unavailable under strict browser privacy
      // policies. Double-check both durable profile routing and the reactive
      // auth epoch around guest-generation capture; a claim or login between
      // either read must retry instead of producing a split ownership pair.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const beforeProfileState = await localProfileStore.refresh();
        const beforeSession = useAuthStore().session;
        const beforeProfile = localProfileStore.current();
        const beforeRemoteUserId = beforeSession?.user.id;
        const beforeUserId = localAccountOwner(beforeSession);
        const beforeToken = beforeSession?.token;
        if (beforeSession && !beforeUserId) continue;
        if (beforeUserId && beforeProfile !== userLocalProfileId(beforeUserId)) continue;
        if (!beforeUserId && beforeProfile !== beforeProfileState.guestProfileId) continue;

        const guestOwner = beforeUserId
          ? undefined
          : await attemptOutbox.captureGuestOwner();

        const afterProfileState = await localProfileStore.refresh();
        const afterSession = useAuthStore().session;
        const afterProfile = localProfileStore.current();
        if (
          afterSession?.user.id !== beforeRemoteUserId
          || localAccountOwner(afterSession) !== beforeUserId
          || afterSession?.token !== beforeToken
          || afterProfile !== beforeProfile
        ) {
          continue;
        }
        if (beforeUserId) return { userId: beforeUserId, localProfileId: beforeProfile };
        if (afterProfile !== afterProfileState.guestProfileId) continue;
        if (!guestOwner?.guestGeneration) continue;
        return { ...guestOwner, localProfileId: beforeProfile };
      }
      throw new Error('Local account ownership changed too often to start a practice session');
    });
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

  /**
   * Durable answer boundary: outbox, archive, local history and the owning
   * practice-session snapshot become visible together or not at all.
   */
  async function commitGradeEvent(input: {
    owner: AttemptOwnerSnapshot;
    attempt: QueuedAttempt;
    grade: {
      partId: string;
      competencyCodes: string[];
      verdict: GradeResult['verdict'];
      awardedPoints: number;
      maxPoints: number;
      now: Date;
    };
    manualGrading?: Grading;
    session: LocalGradeSessionMutation;
  }): Promise<{ ownerId: string; previousFsrs: FsrsState | undefined; session: unknown }> {
    return enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      const result = await localGradeCommitStore.commit(input);
      // An old practice window may finish after this renderer switched to a
      // different account. Its durable write stays with its captured profile,
      // but must never replace the newly active account's reactive archive.
      const currentProfileId = localProfileStore.currentIfInitialized();
      if (result.profileId === currentProfileId) {
        archive.value = result.archive;
        historyVersion.value += 1;
      } else {
        archive.value = await archiveStore.load();
      }
      return {
        ownerId: result.ownerId,
        previousFsrs: result.previousFsrs,
        session: result.session,
      };
    }));
  }

  /** Upload only when the staged owner is still the active authenticated user. */
  async function flushStagedAttempt(userId: string): Promise<void> {
    const auth = useAuthStore();
    // The resolved owner may have been fixed or guest-routed before later
    // archive/history/session writes. Never flush it through a different
    // account that appeared while those awaits were in flight.
    if (userId !== GUEST_ATTEMPT_OWNER && localAccountOwner(auth.session) === userId) {
      await flushAttemptOutbox();
    }
  }

  function isActiveAccountOwner(ownerId: string): boolean {
    return localAccountOwner(useAuthStore().session) === ownerId;
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
  async function beginGuestAttemptClaim(
    userId: string,
    expectedGuestProfileId?: LocalProfileId,
    expectedGuestGeneration?: string,
  ): Promise<void> {
    // Legacy rows are migrated first without rotating anything. The following
    // profile claim then rotates the local guest profile and attempt
    // generation in one storage transaction, so a crash cannot split them.
    await runStorageMutation(storage, () => attemptOutbox.prepareForGuestClaim());
    await claimGuestProfile(userId, expectedGuestProfileId, expectedGuestGeneration);
  }

  /** Persist the exact guest bucket before the unauthenticated redeem POST. */
  async function reserveInviteRegistration(
    serverBaseUrl: string,
    inviteCode: string,
    username: string,
  ): Promise<RegistrationIntent> {
    return runStorageMutation(storage, async () => {
      await attemptOutbox.prepareForGuestClaim();
      await localProfileStore.refresh();
      const sourceProfileId = localProfileStore.current();
      const state = localProfileStore.snapshot();
      if (sourceProfileId !== state.guestProfileId) {
        throw new Error('Invite registration can only claim the active guest profile');
      }
      const owner = await attemptOutbox.captureGuestOwner();
      if (!owner.guestGeneration) throw new Error('Guest attempt generation is unavailable');
      return registrationJournal.reserve({
        serverBaseUrl,
        inviteCode,
        username,
        sourceProfileId,
        sourceGuestGeneration: owner.guestGeneration,
      });
    });
  }

  /**
   * A different registration must never inherit an uncertain predecessor's
   * local work. Rotate to a fresh guest and retain the old profile/attempts in
   * the explicit recovery export before releasing the registration lock.
   */
  async function quarantineInviteRegistration(intent: RegistrationIntent): Promise<void> {
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      await localProfileStore.quarantineGuest(
        intent.sourceProfileId,
        intent.sourceGuestGeneration,
      );
      await attemptOutbox.claim(
        GUEST_ATTEMPT_OWNER,
        AMBIGUOUS_GUEST_ATTEMPT_OWNER,
        intent.sourceGuestGeneration,
      );
      await attemptOutbox.finishGuestClaim(AMBIGUOUS_GUEST_ATTEMPT_OWNER);
      archive.value = await archiveStore.load();
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      conflictContext = undefined;
      archiveChoice.value = undefined;
      archiveChoiceBase = undefined;
      archiveChoiceContext = undefined;
      historyVersion.value += 1;
    }));
  }

  /**
   * Recover only a marker naming this exact account. Ordinary login/init can
   * safely call this: guest data without a matching invite marker is ignored.
   */
  async function recoverGuestAttemptClaim(userId: string): Promise<number> {
    return runStorageMutation(storage, async () => {
      const pending = await attemptOutbox.pendingGuestClaimRoute();
      if (pending?.destinationUserId !== userId) return 0;
      const claimed = await attemptOutbox.claim(
        GUEST_ATTEMPT_OWNER,
        userId,
        pending.sourceGeneration,
      );
      await attemptOutbox.finishGuestClaim(userId);
      return claimed;
    });
  }

  /** Registration helper retained for direct callers/tests. */
  async function claimGuestAttempts(
    userId: string,
    expectedGuestProfileId?: LocalProfileId,
    expectedGuestGeneration?: string,
  ): Promise<number> {
    await beginGuestAttemptClaim(userId, expectedGuestProfileId, expectedGuestGeneration);
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
    contentSource?: CoreSourcePreference;
    contentId?: string;
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
      if (input.contentSource !== undefined) entry.contentSource = input.contentSource;
      if (input.contentId !== undefined) entry.contentId = input.contentId;
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
    replaceCurrentReview?: boolean;
  }): Promise<void> {
    const profileId = localProfileStore.currentIfInitialized();
    if (!profileId) throw new Error('No local profile is active for grading');
    const target = new ArchiveStore(storage, profileId);
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      const next = await target.setGrading({
        partId: input.partId,
        grading: input.grading,
        now: new Date(),
        baseFsrs: input.baseFsrs,
        replaceCurrentReview: input.replaceCurrentReview,
      });
      if (localProfileStore.currentIfInitialized() === profileId) archive.value = next;
    }));
  }

  async function setStarred(partId: string, starred: boolean): Promise<void> {
    const profileId = localProfileStore.currentIfInitialized();
    if (!profileId) throw new Error('No local profile is active for starring');
    const target = new ArchiveStore(storage, profileId);
    await enqueueArchiveMutation(() => runStorageMutation(storage, async () => {
      const next = await target.setStarred(partId, starred, new Date());
      if (localProfileStore.currentIfInitialized() === profileId) archive.value = next;
    }));
  }

  async function toUserState(
    profileId?: LocalProfileId,
    options: { includeLearning?: boolean } = {},
  ): Promise<RecommendUserState> {
    return runStorageMutation(storage, async () => {
      const target = profileId ? new ArchiveStore(storage, profileId) : archiveStore;
      const userState = await target.toUserState();
      const learningProfile = profileId ?? localProfileStore.currentIfInitialized();
      if (options.includeLearning && learningProfile) {
        try {
          const events = (await Promise.all(
            localProfileStore.readableProfiles(learningProfile)
              .map((readable) => learningEventStore.recommendEvents(readable)),
          )).flat().sort((left, right) => right.at.localeCompare(left.at));
          const newest = new Map<string, (typeof events)[number]>();
          for (const event of events) {
            if (!newest.has(event.partId)) newest.set(event.partId, event);
            if (newest.size >= 100) break;
          }
          if (newest.size > 0) userState.learning = { events: [...newest.values()] };
        } catch {
          // Learning signals are optional advice. A malformed telemetry row
          // must not block the authoritative FSRS programme.
        }
      }
      if (!profileId || profileId === localProfileStore.currentIfInitialized()) {
        archive.value = await target.load();
      }
      return userState;
    });
  }

  /**
   * Run one sync round. Guests and offline users no-op gracefully.
   * On conflict the dialog state is populated; resolution happens via
   * resolveConflict().
   */
  async function runSyncRound(
    opts: { quiet: boolean; compareChecksum?: boolean },
    expectedRecovery?: CloudRecoveryContext,
  ): Promise<SyncRunResult> {
    const auth = useAuthStore();
    const app = useAppStore();
    if (!auth.isLoggedIn) return 'guest';
    const context: AccountArchiveContext | undefined = expectedRecovery
      ?? captureAccountArchiveContext();
    if (!context) return 'blocked';
    const isCurrent = () => expectedRecovery
      ? isCurrentCloudRecoveryContext(expectedRecovery)
      : isCurrentAccountArchiveContext(context);
    if (!isCurrent()) return 'blocked';
    if (!app.online) {
      syncStatus.value = { state: 'offline', at: new Date() };
      scheduleCloudRecovery();
      return 'offline';
    }
    const client = clientForContext(context);
    syncStatus.value = { state: 'syncing' };
    try {
      const recovered = await recoverPendingMutations(context);
      if (recovered === 'conflict' || recovered === 'blocked') return recovered;
      if (recovered === 'recovered') return 'synced';
      // Another renderer may grade while this renderer is awaiting the
      // server. Snapshot and commit are tiny lock sections; the network is
      // deliberately outside the lock. A changed snapshot retries against
      // the already-advanced server instead of overwriting newer local work.
      for (let contentionAttempt = 0; contentionAttempt < 4; contentionAttempt += 1) {
        if (!isCurrent()) return 'blocked';
        const local = await loadLatestArchive(context);
        if (!isCurrent()) return 'blocked';
        const serverState = opts.compareChecksum ? await client.getState() : undefined;
        if (!isCurrent()) return 'blocked';
        const { outcome, archive: next, journal } = await performJournaledSync(
          client,
          context,
          local,
          serverState
            ? {
                serverChecksumHint: serverState.checksum,
                serverVersionHint: serverState.archiveVersion,
              }
            : undefined,
        );
        if (!isCurrent()) return 'blocked';
        if (outcome.type === 'conflict') {
          if (!(await archiveIsStillCurrent(local, context))) {
            await completeJournal(context, journal);
            continue;
          }
          if (!isCurrent()) return 'blocked';
          conflict.value = outcome.conflict;
          conflictArchiveBase = local;
          conflictContext = context;
          syncStatus.value = { state: 'conflict', at: new Date() };
          await completeJournal(context, journal);
          return 'conflict';
        }
        if (!(await commitArchiveIfUnchanged(local, next, context))) {
          await completeJournal(context, journal);
          continue;
        }
        await completeJournal(context, journal);
        if (!isCurrent()) return 'blocked';
        clearConflictForContext(context);
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
      if (!isCurrent()) return 'blocked';
      if (isTransientCloudError(e)) {
        syncStatus.value = { state: 'offline', at: new Date() };
        scheduleCloudRecovery();
        return 'offline';
      } else if (e instanceof ApiError && e.status === 401) {
        syncStatus.value = { state: 'error', message: 'Anmeldung abgelaufen — bitte neu anmelden.', at: new Date() };
        return 'error';
      } else {
        syncStatus.value = { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
        // A detached recovery owns its terminal catch. Re-throw local
        // storage/runtime failures so that catch can apply bounded backoff;
        // permanent 4xx/API failures remain visible without retry looping.
        if (expectedRecovery && !(e instanceof ApiError)) throw e;
        if (!opts.quiet) throw e;
        return 'error';
      }
    }
  }

  async function syncNow(opts: { quiet: boolean; compareChecksum?: boolean }): Promise<SyncRunResult> {
    return enqueueArchiveMutation(() => runSyncRound(opts));
  }

  function syncNowForRecovery(context: CloudRecoveryContext): Promise<SyncRunResult> {
    return enqueueArchiveMutation(() => runSyncRound({ quiet: true }, context));
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
  async function reconcileOnLoginUnlocked(
    expectedContext?: AccountArchiveContext,
  ): Promise<void> {
    const context = expectedContext ?? captureAccountArchiveContext();
    if (!context || !isCurrentAccountArchiveContext(context)) return;
    const client = clientForContext(context);
    syncStatus.value = { state: 'syncing' };
    try {
      const recovered = await recoverPendingMutations(context);
      if (recovered) {
        if (recovered === 'recovered') {
          syncStatus.value = { state: 'synced', at: new Date() };
        }
        return;
      }
      for (let contentionAttempt = 0; contentionAttempt < 4; contentionAttempt += 1) {
        if (!isCurrentAccountArchiveContext(context)) return;
        const local = await loadLatestArchive(context);
        if (!isCurrentAccountArchiveContext(context)) return;
        const serverState = await client.getState();
        if (!isCurrentAccountArchiveContext(context)) return;
        const assessment = assessLoginArchives(local, serverState);
        switch (assessment.kind) {
          case 'adopt-server':
          case 'in-sync':
            if (!(await commitArchiveIfUnchanged(local, assessment.archive, context))) continue;
            if (!isCurrentAccountArchiveContext(context)) return;
            syncStatus.value = { state: 'synced', at: new Date() };
            return;
          case 'upload-local': {
            // Empty cloud archive — a plain sync from the server's version
            // fast-forwards the local content up (no data on either side lost).
            const upload: LocalArchive = {
              content: local.content,
              baseVersion: assessment.baseVersion,
            };
            const { outcome, archive: next, journal } = await performJournaledSync(
              client,
              context,
              upload,
            );
            if (!isCurrentAccountArchiveContext(context)) return;
            if (outcome.type === 'conflict') {
              if (!(await archiveIsStillCurrent(local, context))) {
                await completeJournal(context, journal);
                continue;
              }
              if (!isCurrentAccountArchiveContext(context)) return;
              conflict.value = outcome.conflict;
              conflictArchiveBase = local;
              conflictContext = context;
              syncStatus.value = { state: 'conflict', at: new Date() };
              await completeJournal(context, journal);
              return;
            }
            if (!(await commitArchiveIfUnchanged(local, next, context))) {
              await completeJournal(context, journal);
              continue;
            }
            await completeJournal(context, journal);
            if (!isCurrentAccountArchiveContext(context)) return;
            syncStatus.value = { state: 'synced', at: new Date() };
            return;
          }
          case 'choice-needed':
            if (!(await archiveIsStillCurrent(local, context))) continue;
            if (!isCurrentAccountArchiveContext(context)) return;
            archiveChoice.value = {
              serverState: assessment.serverState,
              server: assessment.server,
              local: assessment.local,
            };
            archiveChoiceBase = local;
            archiveChoiceContext = context;
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
      if (!isCurrentAccountArchiveContext(context)) return;
      syncStatus.value =
        e instanceof NetworkError
          ? { state: 'offline', at: new Date() }
          : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
    }
  }

  async function reconcileOnLogin(): Promise<void> {
    await enqueueArchiveMutation(() => reconcileOnLoginUnlocked());
  }

  /** The user's pick in the archive-choice dialog (§2.3). */
  async function resolveArchiveChoice(pick: 'merge' | 'server' | 'local'): Promise<void> {
    await enqueueArchiveMutation(async () => {
      const choice = archiveChoice.value;
      const expected = archiveChoiceBase;
      const context = archiveChoiceContext;
      if (!choice || !expected || !context) return;
      archiveChoicePendingPick = pick;
      if (!isCurrentAccountArchiveContext(context)) {
        archiveChoice.value = undefined;
        archiveChoiceBase = undefined;
        archiveChoiceContext = undefined;
        archiveChoicePendingPick = undefined;
        return;
      }
      const client = clientForContext(context);
      try {
        if (pick === 'server') {
          const adopted: LocalArchive = {
            content: canonicalizeArchive({
              perPart: choice.serverState.perPart,
              perCompetency: choice.serverState.perCompetency,
            }),
            baseVersion: choice.serverState.archiveVersion,
          };
          if (!(await commitArchiveIfUnchanged(expected, adopted, context))) {
            archiveChoice.value = undefined;
            archiveChoiceBase = undefined;
            archiveChoiceContext = undefined;
            await reconcileOnLoginUnlocked(context);
            return;
          }
          if (!isCurrentAccountArchiveContext(context)) return;
          syncStatus.value = { state: 'synced', at: new Date() };
        } else if (pick === 'local') {
          const { outcome, archive: next, journal } = await submitJournaledResolution(
            client,
            context,
            choice.serverState.archiveVersion,
            expected.content,
            expected,
            (clientMutationId) => overwriteServerArchive(
              client,
              choice.serverState.archiveVersion,
              expected.content,
              clientMutationId,
            ),
          );
          if (!isCurrentAccountArchiveContext(context)) return;
          if (outcome.type === 'conflict') {
            await completeJournal(context, journal);
            // Another device wrote while choosing — re-run the assessment.
            archiveChoice.value = undefined;
            archiveChoiceBase = undefined;
            archiveChoiceContext = undefined;
            await reconcileOnLoginUnlocked(context);
            return;
          }
          if (next && !(await commitArchiveIfUnchanged(expected, next, context))) {
            await completeJournal(context, journal);
            archiveChoice.value = undefined;
            archiveChoiceBase = undefined;
            archiveChoiceContext = undefined;
            await reconcileOnLoginUnlocked(context);
            return;
          }
          await completeJournal(context, journal);
          if (!isCurrentAccountArchiveContext(context)) return;
          syncStatus.value = { state: 'synced', at: new Date() };
        } else {
          // merge — the recommended path: a regular contract-§5 sync round;
          // a true conflict falls through to the per-entry conflict dialog.
          archiveChoice.value = undefined;
          archiveChoiceBase = undefined;
          archiveChoiceContext = undefined;
          await runSyncRound({ quiet: false });
        }
        archiveChoice.value = undefined;
        archiveChoiceBase = undefined;
        archiveChoiceContext = undefined;
        archiveChoicePendingPick = undefined;
      } catch (e) {
        if (isCurrentAccountArchiveContext(context)) {
          syncStatus.value =
            e instanceof NetworkError
              ? { state: 'offline', at: new Date() }
              : { state: 'error', message: e instanceof Error ? e.message : String(e), at: new Date() };
          if (isTransientCloudError(e)) scheduleCloudRecovery();
        } else {
          archiveChoice.value = undefined;
          archiveChoiceBase = undefined;
          archiveChoiceContext = undefined;
          archiveChoicePendingPick = undefined;
        }
      }
    });
  }

  /** Postponing is allowed — the next login re-offers the choice (§2.4). */
  function dismissArchiveChoice(): void {
    archiveChoice.value = undefined;
    archiveChoiceBase = undefined;
    archiveChoiceContext = undefined;
    archiveChoicePendingPick = undefined;
    syncStatus.value = { state: 'idle' };
  }

  /** User picked sides in the conflict dialog. */
  async function resolveConflict(choices: Record<string, 'server' | 'local'>): Promise<void> {
    await enqueueArchiveMutation(async () => {
      const current = conflict.value;
      const expected = conflictArchiveBase;
      const context = conflictContext;
      if (!current || !expected || !context) return;
      if (!isCurrentAccountArchiveContext(context)) {
        conflict.value = undefined;
        conflictArchiveBase = undefined;
        conflictContext = undefined;
        return;
      }
      const client = clientForContext(context);
      const resolved: ArchiveContent = buildResolvedArchive(current, choices);
      const { outcome, archive: next, journal } = await submitJournaledResolution(
        client,
        context,
        current.serverVersion,
        resolved,
        expected,
        (clientMutationId) => submitResolution(
          client,
          current,
          resolved,
          clientMutationId,
        ),
      );
      if (!isCurrentAccountArchiveContext(context)) return;
      if (outcome.type === 'conflict') {
        // Another device wrote while the user was choosing — new round.
        if (!(await archiveIsStillCurrent(expected, context))) {
          await completeJournal(context, journal);
          conflict.value = undefined;
          conflictArchiveBase = undefined;
          conflictContext = undefined;
          await runSyncRound({ quiet: true });
          return;
        }
        conflict.value = outcome.conflict;
        conflictArchiveBase = expected;
        conflictContext = context;
        await completeJournal(context, journal);
        return;
      }
      conflict.value = undefined;
      conflictArchiveBase = undefined;
      conflictContext = undefined;
      if (next) {
        if (!(await commitArchiveIfUnchanged(expected, next, context))) {
          await completeJournal(context, journal);
          await runSyncRound({ quiet: true });
          return;
        }
      }
      await completeJournal(context, journal);
      if (!isCurrentAccountArchiveContext(context)) return;
      syncStatus.value = { state: 'synced', at: new Date() };
    });
  }

  function dismissConflict(): void {
    // Allowed: the user can postpone; local progress keeps accumulating and
    // the next sync will re-surface the conflict.
    conflict.value = undefined;
    conflictArchiveBase = undefined;
    conflictContext = undefined;
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
    activateUserProfile,
    activateGuestProfile,
    claimGuestProfile,
    activateProfileForAuth,
    captureAttemptOwner,
    commitGradeEvent,
    stageAttempt,
    flushStagedAttempt,
    isActiveAccountOwner,
    queueAttempt,
    beginGuestAttemptClaim,
    reserveInviteRegistration,
    quarantineInviteRegistration,
    recoverGuestAttemptClaim,
    claimGuestAttempts,
    flushAttemptOutbox,
    scheduleCloudRecovery,
    cancelCloudRecovery,
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
