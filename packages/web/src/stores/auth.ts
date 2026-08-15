/**
 * Auth store. Contract hard rules honored here:
 *  - ordinary login selects that account's isolated local profile,
 *  - invite registration explicitly claims the active guest profile,
 *  - logout switches back to the guest profile and deletes nothing,
 *  - guests can do everything except cloud sync.
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  accountStorageIdentity,
  AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER,
  ApiError,
  canonicalServiceBaseUrl,
  NetworkError,
  RegistrationIntentConflictError,
  ServerClient,
  STORAGE,
  type AuthSession,
  type AuthSessionSnapshot,
  type LocalProfileId,
  type RegistrationIntent,
  type UserInfo,
} from '@qed2/core-logic';
import {
  attemptOutbox,
  authStore as authStorage,
  registrationJournal,
  storage,
} from '../services.js';
import { useAppStore } from './app.js';
import { useProgressStore } from './progress.js';

interface Session extends AuthSession {
  user: UserInfo;
}

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | undefined>();
  const checking = ref(false);
  const transitioning = ref(false);
  const transitionError = ref(false);
  let storageSubscribed = false;
  let externalSessionTail: Promise<void> = Promise.resolve();
  let authGeneration = 0;

  const isLoggedIn = computed(() =>
    !transitioning.value
    && session.value !== undefined
    && issuerOf(session.value) === canonicalCurrentServer());
  const username = computed(() => session.value?.user.username);

  interface AuthActionContext {
    generation: number;
    issuer: string;
    authSnapshot: AuthSessionSnapshot;
    previousSession: Session | undefined;
  }

  function canonicalCurrentServer(): string {
    return canonicalServiceBaseUrl(useAppStore().config.serverBaseUrl);
  }

  function issuerOf(candidate: AuthSession): string | undefined {
    const value = candidate.serverBaseUrl;
    if (!value) return undefined;
    try {
      return canonicalServiceBaseUrl(value);
    } catch {
      return undefined;
    }
  }

  function isTransientAuthFailure(error: unknown): boolean {
    return error instanceof NetworkError
      || (error instanceof ApiError
        && (error.status === 408
          || error.status === 425
          || error.status === 429
          || error.status >= 500));
  }

  function localAccountId(candidate: AuthSession): string {
    const issuer = issuerOf(candidate);
    if (!issuer) throw new Error('Stored login has no valid Server identity');
    return accountStorageIdentity(issuer, candidate.user.id);
  }

  function beginTransition(): number {
    const generation = ++authGeneration;
    transitioning.value = true;
    transitionError.value = false;
    checking.value = true;
    return generation;
  }

  function transitionIsCurrent(generation: number, issuer?: string): boolean {
    return generation === authGeneration
      && (issuer === undefined || issuer === canonicalCurrentServer());
  }

  function finishTransition(generation: number): void {
    if (generation !== authGeneration || transitionError.value) return;
    checking.value = false;
    transitioning.value = false;
    transitionError.value = false;
  }

  function lockTransition(generation: number, cause: unknown): never {
    if (generation === authGeneration) {
      transitionError.value = true;
      transitioning.value = true;
      checking.value = false;
      console.error('[qed2] account transition could not be made consistent', cause);
    }
    throw cause;
  }

  async function restoreProfile(previous: Session | undefined): Promise<void> {
    const progress = useProgressStore();
    if (previous) await progress.activateProfileForAuth(localAccountId(previous));
    else await progress.activateGuestProfile();
  }

  async function failTransition(
    generation: number,
    previous: Session | undefined,
    cause: unknown,
  ): Promise<never> {
    if (generation === authGeneration) {
      try {
        await restoreProfile(previous);
        session.value = previous;
        finishTransition(generation);
      } catch (rollbackError) {
        lockTransition(generation, rollbackError);
      }
    }
    throw cause;
  }

  async function startAuthAction(issuer: string): Promise<AuthActionContext> {
    const generation = beginTransition();
    const authSnapshot = await authStorage.snapshot().catch((error) =>
      failTransition(generation, session.value, error));
    if (!transitionIsCurrent(generation, issuer)) {
      finishTransition(generation);
      throw new Error('Account operation was superseded');
    }
    return { generation, issuer, authSnapshot, previousSession: session.value };
  }

  async function rollbackDurableAuth(
    committed: AuthSessionSnapshot,
    previous: AuthSessionSnapshot,
  ): Promise<boolean> {
    return previous.inspection.status === 'valid'
      ? authStorage.setSessionIfUnchanged(previous.inspection.session, committed)
      : authStorage.clearSessionIfUnchanged(committed);
  }

  async function recoverInviteOwnership(candidate: Session): Promise<void> {
    const progress = useProgressStore();
    const registration = await registrationJournal.pending();
    if (
      registration
      && registration.status === 'redeemed'
      && registration.destinationUserId === candidate.user.id
      && registration.serverBaseUrl === issuerOf(candidate)
      && registration.usernameKey === candidate.user.username.trim().toLowerCase()
    ) {
      await progress.beginGuestAttemptClaim(
        localAccountId(candidate),
        registration.sourceProfileId,
        registration.sourceGuestGeneration,
      );
      await progress.recoverGuestAttemptClaim(localAccountId(candidate));
      await registrationJournal.complete(registration.clientMutationId);
      return;
    }
    await progress.recoverGuestAttemptClaim(localAccountId(candidate));
  }

  function wireTokenProvider(): void {
    const app = useAppStore();
    app.setTokenProvider(() => {
      const current = session.value;
      if (!current) return undefined;
      return issuerOf(current) === canonicalCurrentServer() ? current.token : undefined;
    });
  }

  async function invalidateForServerChange(nextServerBaseUrl: string): Promise<void> {
    const nextIssuer = canonicalServiceBaseUrl(nextServerBaseUrl);
    const previous = session.value;
    if (previous && issuerOf(previous) === nextIssuer) return;
    const generation = beginTransition();
    const authSnapshot = await authStorage.snapshot().catch((error) =>
      failTransition(generation, previous, error));
    const progress = useProgressStore();
    progress.cancelCloudRecovery();
    try {
      // Scope any still-global 2.1 attempts to the old Server before the
      // resolver/configuration changes.
      await attemptOutbox.migrateLegacy();
      await progress.activateGuestProfile();
      if (!transitionIsCurrent(generation)) throw new Error('Server change was superseded');
      const cleared = await authStorage.clearSessionIfUnchanged(authSnapshot);
      if (!cleared) {
        finishTransition(generation);
        await refreshFromStorage();
        return;
      }
      session.value = undefined;
      finishTransition(generation);
    } catch (error) {
      await failTransition(generation, previous, error);
    }
  }

  function refreshFromStorage(): Promise<void> {
    const generation = beginTransition();
    const previous = session.value;
    // Invalidate immediately, before the asynchronous storage read. A timer
    // whose callback has already begun is fenced by its generation.
    useProgressStore().cancelCloudRecovery();
    // Read-only refresh: it cannot create a broadcast loop. Serialize reads
    // so an older candidate can never publish after a newer one.
    const reload = async () => {
      const inspected = await authStorage.inspectSession().catch((error) =>
        failTransition(generation, previous, error));
      const stored = inspected.status === 'valid' ? inspected.session : undefined;
      const currentIssuer = canonicalCurrentServer();
      const candidateIssuer = stored ? issuerOf(stored) : undefined;
      const candidate = stored && candidateIssuer === currentIssuer
        ? { ...stored, serverBaseUrl: candidateIssuer! }
        : undefined;
      const progress = useProgressStore();
      // Publish the new token only after its isolated profile is ready. If
      // storage/profile activation fails, the previous auth epoch remains.
      if (!transitionIsCurrent(generation)) return;
      try {
        if (candidate) {
          await progress.activateProfileForAuth(localAccountId(candidate));
          await recoverInviteOwnership(candidate);
        } else await progress.activateGuestProfile();
      } catch (error) {
        // The durable auth row is authoritative here. Restoring an older
        // in-memory session after its new profile failed to open would expose
        // an auth/profile mismatch, so keep the whole app locked for reload.
        lockTransition(generation, error);
      }
      if (!transitionIsCurrent(generation)) return;
      session.value = candidate;
      finishTransition(generation);
    };
    const run = externalSessionTail.then(reload, reload);
    const guarded = run.catch(async (error) => {
      if (generation === authGeneration && !transitionError.value) {
        await failTransition(generation, previous, error).catch(() => undefined);
      }
      console.error('[qed2] account change could not activate its local profile', error);
    });
    externalSessionTail = guarded;
    return guarded;
  }

  function subscribeStorageChanges(): void {
    if (!storageSubscribed && storage.onChange) {
      storageSubscribed = true;
      storage.onChange((change) => {
        if (change.collection !== STORAGE.auth) return;
        void refreshFromStorage();
      });
    }
  }

  async function init(): Promise<void> {
    wireTokenProvider();
    subscribeStorageChanges();
    attemptOutbox.configureLegacyAccountOwner(() => AMBIGUOUS_ACCOUNT_ATTEMPT_OWNER);
    const generation = beginTransition();
    const previous = session.value;
    const authSnapshot = await authStorage.snapshot().catch((error) =>
      failTransition(generation, previous, error));
    const inspected = authSnapshot.inspection;
    const rawStored = inspected.status === 'valid' ? inspected.session : undefined;
    const currentIssuer = canonicalCurrentServer();
    const storedIssuer = rawStored ? issuerOf(rawStored) : undefined;
    if (!rawStored || storedIssuer !== currentIssuer) {
      // The boot pre-read is only a hint. Another renderer may sign out
      // between that read and auth initialisation, so an empty authoritative
      // read must also switch the local profile back to the current guest.
      // Keeping the preselected user profile here would pair guest writes
      // with somebody else's archive on a shared device.
      try {
        useProgressStore().cancelCloudRecovery();
        await useProgressStore().activateGuestProfile();
        if (inspected.status !== 'missing') {
          const cleared = await authStorage.clearSessionIfUnchanged(authSnapshot);
          if (!cleared) {
            finishTransition(generation);
            await refreshFromStorage();
            return;
          }
        }
        session.value = undefined;
        finishTransition(generation);
        return;
      } catch (error) {
        await failTransition(generation, previous, error);
      }
    }
    const stored: Session = { ...rawStored!, serverBaseUrl: storedIssuer! };
    let effective = stored;
    try {
      useProgressStore().cancelCloudRecovery();
      await useProgressStore().activateProfileForAuth(localAccountId(stored));
      if (!transitionIsCurrent(generation, storedIssuer)) return;
      const client = new ServerClient(storedIssuer!, () => stored.token);
      if (authStorage.isExpiringSoon(stored, new Date())) {
        const refreshed = await client.refresh();
        if (!transitionIsCurrent(generation, storedIssuer)) return;
        const next: Session = { ...stored, token: refreshed.token, expiresAt: refreshed.expiresAt };
        useProgressStore().cancelCloudRecovery();
        const committed = await authStorage.setSessionIfUnchanged(next, authSnapshot);
        if (!committed) {
          finishTransition(generation);
          await refreshFromStorage();
          return;
        }
        effective = next;
      } else {
        const identity = await client.me();
        if (!transitionIsCurrent(generation, storedIssuer)) return;
        if (identity.id !== stored.user.id) {
          throw new Error('Stored login resolved to a different account');
        }
      }
    } catch (e) {
      if (!transitionIsCurrent(generation, storedIssuer)) return;
      if (e instanceof ApiError && e.status === 401) {
        // Token no longer valid — back to guest. Local archive is untouched.
        useProgressStore().cancelCloudRecovery();
        try {
          await useProgressStore().activateGuestProfile();
          const latest = await authStorage.snapshot();
          if (
            latest.inspection.status !== 'valid'
            || latest.inspection.session.token !== stored.token
            || issuerOf(latest.inspection.session) !== storedIssuer
          ) {
            finishTransition(generation);
            await refreshFromStorage();
            return;
          }
          const cleared = await authStorage.clearSessionIfUnchanged(latest);
          if (!cleared) {
            finishTransition(generation);
            await refreshFromStorage();
            return;
          }
          session.value = undefined;
          finishTransition(generation);
          return;
        } catch (error) {
          lockTransition(generation, error);
        }
      } else if (!isTransientAuthFailure(e)) {
        lockTransition(generation, e);
      }
      // Network and transient HTTP failures keep the issuer-bound session;
      // the local app remains usable while cloud operations show degraded.
    }
    // A prior invite redemption may have committed this session immediately
    // before the renderer crashed. Only a marker naming this exact account can
    // claim the guest outbox; ordinary stored sessions remain no-ops.
    try {
      if (!transitionIsCurrent(generation, storedIssuer)) return;
      await recoverInviteOwnership(effective);
      if (!transitionIsCurrent(generation, storedIssuer)) return;
      const latest = await authStorage.snapshot();
      if (
        latest.inspection.status !== 'valid'
        || latest.inspection.session.token !== effective.token
        || issuerOf(latest.inspection.session) !== storedIssuer
      ) {
        finishTransition(generation);
        await refreshFromStorage();
        return;
      }
      session.value = effective;
      finishTransition(generation);
    } catch (error) {
      lockTransition(generation, error);
    }
  }

  async function afterAuth(
    s: Session,
    context: AuthActionContext,
    options: {
      claimGuestAttempts?: boolean;
      expectedGuestProfileId?: LocalProfileId;
      expectedGuestGeneration?: string;
      registrationIntent?: RegistrationIntent;
    } = {},
  ): Promise<void> {
    const progress = useProgressStore();
    // The login response identifies a new auth epoch. Fence old-account
    // recovery before any guest claim, session write or login reconciliation.
    progress.cancelCloudRecovery();
    let committedSnapshot: AuthSessionSnapshot | undefined;
    let durableSessionCommitted = false;
    try {
      if (!transitionIsCurrent(context.generation, context.issuer)) {
        throw new Error('Account response was superseded');
      }
      const committed = await authStorage.setSessionIfUnchanged(s, context.authSnapshot);
      if (!committed) {
        finishTransition(context.generation);
        await refreshFromStorage();
        throw new Error('Login changed in another window');
      }
      durableSessionCommitted = true;
      committedSnapshot = await authStorage.snapshot();
      if (
        committedSnapshot.inspection.status !== 'valid'
        || committedSnapshot.inspection.session.token !== s.token
      ) throw new Error('Persisted login could not be verified');
      if (!transitionIsCurrent(context.generation, context.issuer)) {
        throw new Error('Account response was superseded');
      }
      if (options.claimGuestAttempts) {
        // The exact guest profile and attempt generation were captured before
        // the redeem request. A response can never claim a later visitor.
        await progress.beginGuestAttemptClaim(
          localAccountId(s),
          options.expectedGuestProfileId,
          options.expectedGuestGeneration,
        );
      } else {
        await progress.activateProfileForAuth(localAccountId(s));
      }
      await progress.recoverGuestAttemptClaim(localAccountId(s));
      if (options.registrationIntent) {
        await registrationJournal.complete(options.registrationIntent.clientMutationId);
      }
      const latest = await authStorage.snapshot();
      if (
        !transitionIsCurrent(context.generation, context.issuer)
        || latest.inspection.status !== 'valid'
        || latest.inspection.session.token !== s.token
      ) throw new Error('Account changed while its local profile was opening');
      session.value = s;
      finishTransition(context.generation);
    } catch (error) {
      if (durableSessionCommitted && !committedSnapshot) {
        lockTransition(context.generation, error);
      }
      if (committedSnapshot && transitionIsCurrent(context.generation, context.issuer)) {
        const rolledBack = await rollbackDurableAuth(
          committedSnapshot,
          context.authSnapshot,
        ).catch(() => false);
        if (!rolledBack) lockTransition(context.generation, error);
      }
      await failTransition(context.generation, context.previousSession, error);
    }
    // Login-time reconciliation (history-and-archive-choice upgrade §2):
    // silent when one side is empty or checksums match; otherwise the
    // archive-choice dialog lets the user pick merge / cloud / local.
    await progress.reconcileOnLogin();
    await progress.flushAttemptOutbox();
  }

  async function login(usernameInput: string, password: string): Promise<void> {
    const issuer = canonicalCurrentServer();
    const context = await startAuthAction(issuer);
    try {
      const res = await new ServerClient(issuer).login(usernameInput, password);
      if (!transitionIsCurrent(context.generation, issuer)) {
        throw new Error('Login response was superseded');
      }
      const next = { token: res.token, expiresAt: res.expiresAt, user: res.user, serverBaseUrl: issuer };
      const pending = await registrationJournal.pending();
      const matchesPendingRegistration = pending?.status === 'redeemed'
        && pending.destinationUserId === res.user.id
        && pending.serverBaseUrl === issuer
        && pending.usernameKey === res.user.username.trim().toLowerCase();
      await afterAuth(next, context, matchesPendingRegistration
        ? {
            claimGuestAttempts: true,
            expectedGuestProfileId: pending.sourceProfileId,
            expectedGuestGeneration: pending.sourceGuestGeneration,
            registrationIntent: pending,
          }
        : {});
    } catch (error) {
      if (context.generation === authGeneration && transitioning.value) {
        await failTransition(context.generation, context.previousSession, error);
      }
      throw error;
    }
  }

  async function redeem(inviteCode: string, usernameInput: string, password: string): Promise<void> {
    const issuer = canonicalCurrentServer();
    const context = await startAuthAction(issuer);
    const progress = useProgressStore();
    let intent: RegistrationIntent | undefined;
    try {
      for (;;) {
        try {
          intent = await progress.reserveInviteRegistration(issuer, inviteCode, usernameInput);
          break;
        } catch (error) {
          if (!(error instanceof RegistrationIntentConflictError)) throw error;
          // A successful Server response has already bound this bucket to an
          // account. A different window/request may neither quarantine it nor
          // delete its recovery proof; the matching session must finish first.
          if (error.existing.status === 'redeemed') throw error;
          await progress.quarantineInviteRegistration(error.existing);
          await registrationJournal.complete(error.existing.clientMutationId);
        }
      }
      const res = await new ServerClient(issuer).redeem(
        inviteCode,
        usernameInput,
        password,
        intent.clientMutationId,
      );
      if (!transitionIsCurrent(context.generation, issuer)) {
        throw new Error('Invite response was superseded');
      }
      if (res.user.username.trim().toLowerCase() !== intent.usernameKey) {
        throw new Error('Invite registration returned a different account identity');
      }
      intent = await registrationJournal.markRedeemed(intent.clientMutationId, res.user.id);
      await afterAuth(
        { token: res.token, expiresAt: res.expiresAt, user: res.user, serverBaseUrl: issuer },
        context,
        {
          claimGuestAttempts: true,
          expectedGuestProfileId: intent.sourceProfileId,
          expectedGuestGeneration: intent.sourceGuestGeneration,
          registrationIntent: intent,
        },
      );
    } catch (error) {
      // These responses prove that no account was committed for this
      // mutation. Release the reservation without rotating or assigning the
      // guest. Network/5xx/MUTATION_ID_REUSED remain durable for exact replay
      // or explicit quarantine because the Server outcome may be uncertain.
      if (
        error instanceof ApiError
        && ['BAD_REQUEST', 'INVITE_INVALID', 'USERNAME_TAKEN'].includes(error.code)
      ) {
        const pending = await registrationJournal.pending().catch(() => undefined);
        if (
          intent
          && pending?.status === 'reserved'
          && pending.clientMutationId === intent.clientMutationId
        ) {
          await registrationJournal.complete(intent.clientMutationId).catch(() => undefined);
        }
      }
      if (context.generation === authGeneration && transitioning.value) {
        await failTransition(context.generation, context.previousSession, error);
      }
      throw error;
    }
  }

  async function logout(): Promise<void> {
    const progress = useProgressStore();
    const previous = session.value;
    const generation = beginTransition();
    const authSnapshot = await authStorage.snapshot().catch((error) =>
      failTransition(generation, previous, error));
    progress.cancelCloudRecovery();
    // Best-effort final sync so nothing is stranded locally-only.
    try {
      await progress.flushAttemptOutbox();
      await progress.syncNow({ quiet: true });
    } catch {
      /* offline logout is fine */
    }
    // The best-effort sync above may itself have observed an offline server
    // and scheduled recovery. Remove that timer before clearing the session.
    progress.cancelCloudRecovery();
    try {
      if (!transitionIsCurrent(generation)) return;
      // Hide the transition in App.vue, prepare the guest profile first, and
      // only then publish the unauthenticated identity. If storage fails, the
      // previous account/profile pair remains observable together.
      await progress.activateGuestProfile();
      const cleared = await authStorage.clearSessionIfUnchanged(authSnapshot);
      if (!cleared) {
        finishTransition(generation);
        await refreshFromStorage();
        return;
      }
      session.value = undefined;
      finishTransition(generation);
    } catch (error) {
      await failTransition(generation, previous, error);
    }
  }

  const app = useAppStore();
  app.setServerEndpointChangeGuard(invalidateForServerChange);
  watch(
    () => app.config.serverBaseUrl,
    (next, previous) => {
      if (next === previous || !session.value) return;
      // External settings changes bypass updateConfig's awaited guard. Calling
      // an async function executes the bearer removal before its first await.
      void invalidateForServerChange(next);
    },
    { flush: 'sync' },
  );

  return {
    session,
    checking,
    transitioning,
    transitionError,
    isLoggedIn,
    username,
    init,
    login,
    redeem,
    logout,
    refreshFromStorage,
  };
});
