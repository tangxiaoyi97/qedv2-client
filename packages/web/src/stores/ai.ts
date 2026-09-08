/**
 * AI state: what this server can do, what this account may use, and a cache of
 * answers already paid for.
 *
 * Everything here degrades to "off". A server with no `ai` block in `GET /info`
 * — an older one, or one with the flags down — leaves every AI entry point
 * unrendered rather than showing something that then fails.
 */
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch } from 'vue';
import {
  aiCacheDigest,
  AI_CACHE_META_KEY,
  AiCacheWriteInvalidatedError,
  accountStorageIdentity,
  buildAssessRequest,
  buildExplainRequest,
  cacheableAiAssessResponse,
  cacheableAiExplainResponse,
  secureRandomUuidV4,
  hasAtomicStorage,
  hasFigures,
  hasSolutionFigures,
  hintRevealsOfficialSolution,
  isAiGradable,
  parseCachedAiAssessResponse,
  parseCachedAiExplainResponse,
  type AiAssessResult,
  type AiAssessCacheLocator,
  type AiCapabilities,
  type AiCredentialTestRequest,
  type AiCredentialTestResponse,
  type AiExplainMode,
  type AiExplainCacheLocator,
  type AiExplainRequest,
  type AiExplainResult,
  type AiRequestContext,
  type AiStatus,
  type GradeResult,
  type Question,
  type QuestionPart,
  type LocalProfileId,
  ServerClient,
  STORAGE,
  userLocalProfileId,
} from '@qed2/core-logic';
import {
  aiCache,
  aiCredentialTestJournal,
  aiRequestGenerationJournal,
  localProfileStore,
  storage,
} from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

interface ExplainInput {
  question: Question;
  part: QuestionPart;
  submitted: string;
  result?: GradeResult;
  mode?: AiExplainMode;
  hintLevel?: 1 | 2 | 3;
  identity?: AiRequestContext;
}

interface AssessInput {
  question: Question;
  part: QuestionPart;
  submitted: string;
  maxPoints: number;
  scoreOptions?: number[];
  identity?: AiRequestContext;
}

interface AiProfilePreferences {
  version: 1;
  preferPool?: boolean;
  customInstructions?: string;
  updatedAt: string;
}

function aiProfilePreferencesKey(profileId: LocalProfileId): string {
  return `ai-preferences/v1/${encodeURIComponent(profileId)}`;
}

function parseAiProfilePreferences(value: unknown): AiProfilePreferences | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI profile preferences are malformed');
  }
  const row = value as Partial<AiProfilePreferences> & Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['version', 'preferPool', 'customInstructions', 'updatedAt'].includes(key))
    || row.version !== 1
    || (row.preferPool !== undefined && typeof row.preferPool !== 'boolean')
    || (row.customInstructions !== undefined
      && (typeof row.customInstructions !== 'string' || row.customInstructions.length > 600))
    || typeof row.updatedAt !== 'string'
    || Number.isNaN(Date.parse(row.updatedAt))
  ) throw new Error('AI profile preferences are malformed');
  return {
    version: 1,
    ...(row.preferPool !== undefined ? { preferPool: row.preferPool } : {}),
    ...(row.customInstructions ? { customInstructions: row.customInstructions } : {}),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export interface PaidAiRequestOptions {
  /** Explicitly buy a replacement after the previous receipt was confirmed. */
  newRequest?: boolean;
  /** Generation shown by the failed request; required for `newRequest`. */
  expectedGeneration?: number;
}

export interface PaidAiRequestFailure extends Error {
  paidRequestGeneration?: number;
}

export interface CredentialTestOptions {
  newRequest?: boolean;
  expectedClientRequestId?: string;
}

interface StablePaidRequest<T> {
  request: T;
  generation?: number;
}

interface PaidOperationContext {
  userId: string;
  token: string;
  serverBaseUrl: string;
  serverCommit?: string;
  client: ServerClient;
  promptVersion: string;
  source: 'pool' | 'byo';
  provider?: string;
  model?: string;
  promptPrefs: {
    preferPool: boolean;
    language?: string;
    customInstructions?: string;
  };
  cacheScope: string;
  fingerprint: string;
}

export const useAiStore = defineStore('ai', () => {
  const app = useAppStore();
  const auth = useAuthStore();
  const profilePreferences = ref<AiProfilePreferences | null>(null);
  const profilePreferencesReady = ref(false);
  let profilePreferencesRequest = 0;

  function expectedAuthenticatedProfile(): LocalProfileId | undefined {
    const session = auth.session;
    if (!session?.user.id) return undefined;
    return userLocalProfileId(accountStorageIdentity(app.config.serverBaseUrl, session.user.id));
  }

  const activeProfileMatchesAuth = computed(() => {
    const expected = expectedAuthenticatedProfile();
    return expected !== undefined && localProfileStore.currentIfInitialized() === expected;
  });

  async function updateProfilePreferences(
    profileId: LocalProfileId,
    partial: { preferPool?: boolean | undefined; customInstructions?: string | undefined },
  ): Promise<AiProfilePreferences> {
    const key = aiProfilePreferencesKey(profileId);
    const address = { collection: STORAGE.config, key } as const;
    const merge = (current: AiProfilePreferences | undefined): AiProfilePreferences => {
      const next: AiProfilePreferences = {
        version: 1,
        ...(current?.preferPool !== undefined ? { preferPool: current.preferPool } : {}),
        ...(current?.customInstructions ? { customInstructions: current.customInstructions } : {}),
        updatedAt: new Date().toISOString(),
      };
      if (Object.prototype.hasOwnProperty.call(partial, 'preferPool')) {
        if (partial.preferPool === undefined) delete next.preferPool;
        else next.preferPool = partial.preferPool;
      }
      if (Object.prototype.hasOwnProperty.call(partial, 'customInstructions')) {
        const text = partial.customInstructions?.trim().slice(0, 600);
        if (!text) delete next.customInstructions;
        else next.customInstructions = text;
      }
      return parseAiProfilePreferences(next)!;
    };
    if (!hasAtomicStorage(storage)) {
      const next = merge(parseAiProfilePreferences(await storage.get(STORAGE.config, key)));
      await storage.set(STORAGE.config, key, next);
      return next;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const [entry] = await storage.readBatch([address]);
      if (!entry) throw new Error('AI profile preference read returned no entry');
      const next = merge(parseAiProfilePreferences(entry.value));
      const committed = await storage.commitBatch({
        ifRevisions: [{ ...address, revision: entry.revision }],
        mutations: [{ ...address, operation: 'set', value: next }],
      });
      if (committed.committed) return next;
    }
    throw new Error('AI profile preferences changed too often');
  }

  async function loadProfilePreferences(): Promise<void> {
    const request = ++profilePreferencesRequest;
    const profileId = localProfileStore.currentIfInitialized();
    profilePreferencesReady.value = false;
    profilePreferences.value = null;
    if (!profileId) return;
    let stored = parseAiProfilePreferences(
      await storage.get(STORAGE.config, aiProfilePreferencesKey(profileId)),
    );
    if (!stored && (app.config.aiCustomInstructions || app.config.aiPreferPool !== undefined)) {
      stored = await updateProfilePreferences(profileId, {
        ...(app.config.aiCustomInstructions
          ? { customInstructions: app.config.aiCustomInstructions }
          : {}),
        ...(app.config.aiPreferPool !== undefined ? { preferPool: app.config.aiPreferPool } : {}),
      });
      // The legacy device-wide values are ignored after one scoped migration.
      // Keeping an explicit undefined in the compatibility document prevents a
      // second account from inheriting the first account's private prompt.
      await app.updateConfig({ aiCustomInstructions: undefined, aiPreferPool: undefined });
    }
    if (request !== profilePreferencesRequest || localProfileStore.currentIfInitialized() !== profileId) return;
    profilePreferences.value = stored ?? {
      version: 1,
      updatedAt: new Date(0).toISOString(),
    };
    profilePreferencesReady.value = true;
  }

  watch(
    [() => auth.session?.user.id, () => app.config.serverBaseUrl],
    () => { void loadProfilePreferences(); },
    { immediate: true, flush: 'sync' },
  );

  /**
   * Derived from the `/info` the app store already fetches — one probe, not
   * two. Absent block ⇒ this server has no AI, and every entry point stays
   * unrendered.
   */
  const capabilities = computed<AiCapabilities | null>(() => app.serverInfo?.ai ?? null);

  const status = ref<AiStatus | null>(null);
  const statusError = ref<string | null>(null);
  let statusRequest = 0;
  let statusOwner: string | undefined;

  /**
   * Answers already fetched.
   *
   * Two layers: a Map so a re-render is instant, and AiCache behind it so a
   * reload does not buy the same explanation twice. The Map used to be the
   * only layer, which made the cache worth very little — the commonest way to
   * look at an explanation again is to come back to the question later.
   */
  const explainCache = ref(new Map<string, AiExplainResult>());
  const assessCache = ref(new Map<string, AiAssessResult>());
  let cacheClearGeneration = 0;
  /** Paid content is still shown; this warns that crash-safe replay could not be saved. */
  const cacheWarning = ref<string | null>(null);
  const invalidateMemoryCache = (): void => {
    explainCache.value = new Map();
    assessCache.value = new Map();
  };
  const advanceCacheInvalidation = (): void => {
    cacheClearGeneration += 1;
    invalidateMemoryCache();
  };
  const stopCacheChanges = storage.onChange?.((change) => {
    if (
      change.collection === STORAGE.aiCache
      && change.key?.startsWith(AI_CACHE_META_KEY)
    ) {
      // StoragePort change notifications come only from another renderer.
      // Treat every remote meta write conservatively as a clear barrier so an
      // older read/write cannot repopulate memory after the event was seen.
      advanceCacheInvalidation();
      return;
    }
    const profileId = localProfileStore.currentIfInitialized();
    if (
      profileId
      && change.collection === STORAGE.config
      && change.key === aiProfilePreferencesKey(profileId)
    ) void loadProfilePreferences();
  });
  if (stopCacheChanges) onScopeDispose(stopCacheChanges);
  const beginCacheClear = advanceCacheInvalidation;
  const onWindowFocus = (): void => invalidateMemoryCache();
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') invalidateMemoryCache();
  };
  if (typeof window !== 'undefined') window.addEventListener('focus', onWindowFocus);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  onScopeDispose(() => {
    if (typeof window !== 'undefined') window.removeEventListener('focus', onWindowFocus);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  /**
   * Explanation is offered only when the server has it switched on AND the
   * account can actually pay for it. Showing a button that always 402s is
   * worse than showing nothing.
   */
  const canUsePaidSource = computed(
    () =>
      available.value &&
      profilePreferencesReady.value &&
      status.value !== null &&
      selectedSourceReady.value,
  );
  const paidProtocolReady = computed(() =>
    Number.isInteger(capabilities.value?.idempotencyWindowDays)
    && (capabilities.value?.idempotencyWindowDays ?? 0) > 0,
  );

  /** Capability and entitlement readiness are separate: setup is an action,
   * never a pretend paid feature or permission inferred from a shared key. */
  function featureOffered(feature: 'answer' | 'walkthrough' | 'hint' | 'diagnosis' | 'assess'): boolean {
    // Both legacy answer and walkthrough are controlled by Server's one
    // explanation flag; their advertised task versions remain independent.
    const flag = feature === 'answer' || feature === 'walkthrough' ? 'explain' : feature;
    return available.value
      && paidProtocolReady.value
      && capabilities.value?.[flag] === true
      && status.value?.features[flag] === true
      && Boolean(capabilities.value.taskVersions?.[feature]);
  }
  const hintOffered = computed(() => featureOffered('hint'));
  const diagnosisOffered = computed(() => featureOffered('diagnosis'));
  const canExplain = computed(() => canUsePaidSource.value && featureOffered('answer'));

  const canHint = computed(
    () => canUsePaidSource.value && hintOffered.value,
  );

  const canDiagnose = computed(
    () => canUsePaidSource.value && diagnosisOffered.value,
  );
  const canTestCredential = computed(() =>
    auth.isLoggedIn
    && activeProfileMatchesAuth.value
    && paidProtocolReady.value
    && capabilities.value?.credentialTest === true
    && Boolean(capabilities.value.taskVersions?.capabilityTest)
    && byoOffered.value
    && status.value?.byo.configured === true,
  );

  /** Nothing works until one of the two modes is actually usable. */
  const configured = computed(
    () => poolOffered.value || (byoOffered.value && status.value?.byo.configured === true),
  );

  /**
   * Whether to show AI anywhere at all.
   *
   * Requires a session, not just a server that supports it. The endpoints are
   * behind JwtAuthGuard anyway, so a guest could only ever collect 401s — and
   * an entry point that exists but always refuses is worse than no entry
   * point. Guests see nothing.
   */
  const available = computed(
    () =>
      auth.isLoggedIn &&
      activeProfileMatchesAuth.value &&
      capabilities.value !== null &&
      (capabilities.value.explain
        || capabilities.value.assess
        || capabilities.value.hint === true
        || capabilities.value.diagnosis === true)
      // A fresh authenticated status can veto stale public /info flags.
      // Until status arrives, Settings may still show its loading state.
      && (status.value === null
        || status.value.features.explain
        || status.value.features.assess
        || status.value.features.hint === true
        || status.value.features.diagnosis === true),
  );

  const poolOnlyServer = computed(() => capabilities.value?.poolAvailable === true);

  /**
   * Whether an AI verdict may even be requested for this part.
   *
   * Three gates, and the bank owns the first one: `grader: 'ai'` is per
   * question, so the content decides which rubrics are good enough to judge
   * against. The client never overrides that.
   */
  function assessmentOffered(part: QuestionPart, question?: Question): boolean {
    return (
      featureOffered('assess') &&
      isAiGradable(part) &&
      (!question || !hasFigures(question, part))
    );
  }

  function canAssess(part: QuestionPart, question?: Question): boolean {
    return canUsePaidSource.value && assessmentOffered(part, question);
  }

  /** Text-only learning calls never cross an official-solution figure. */
  function canLearn(question: Question, part: QuestionPart): boolean {
    void question;
    return !hasSolutionFigures(part);
  }

  function captureAuthenticatedOperation(): {
    userId: string;
    token: string;
    serverBaseUrl: string;
    serverCommit?: string;
    client: ServerClient;
  } {
    const session = auth.session;
    if (
      !auth.isLoggedIn
      || !session?.token
      || !session.user.id
      || !activeProfileMatchesAuth.value
    ) {
      throw new Error('Für diese KI-Aktion ist eine Anmeldung erforderlich.');
    }
    return {
      userId: session.user.id,
      token: session.token,
      serverBaseUrl: app.config.serverBaseUrl,
      ...(app.serverInfo?.commit ? { serverCommit: app.serverInfo.commit } : {}),
      // Never retain the app's live token provider across a journal/storage
      // await. This immutable client cannot accidentally submit A's secret
      // mutation with B's token after another window changes the session.
      client: new ServerClient(app.config.serverBaseUrl, () => session.token),
    };
  }

  function operationIsCurrent(context: {
    userId: string;
    token: string;
    serverBaseUrl: string;
  }): boolean {
    return auth.isLoggedIn
      && activeProfileMatchesAuth.value
      && auth.session?.user.id === context.userId
      && auth.session?.token === context.token
      && app.config.serverBaseUrl === context.serverBaseUrl;
  }

  function assertOperationCurrent(context: {
    userId: string;
    token: string;
    serverBaseUrl: string;
  }): void {
    if (!operationIsCurrent(context)) throw staleRequestError();
  }

  async function refreshStatus(): Promise<void> {
    const request = ++statusRequest;
    const owner = JSON.stringify([app.config.serverBaseUrl, auth.session?.user.id, auth.session?.token]);
    if (statusOwner !== owner) {
      statusOwner = owner;
      status.value = null;
      statusError.value = null;
    }
    if (!auth.isLoggedIn || capabilities.value === null) {
      status.value = null;
      statusError.value = null;
      return;
    }
    try {
      const next = await app.serverClient.aiStatus();
      if (request !== statusRequest) return;
      status.value = next;
      statusError.value = null;
    } catch (e) {
      if (request !== statusRequest) return;
      status.value = null;
      statusError.value = messageOf(e);
    }
  }

  async function saveCredential(input: {
    provider: 'openai' | 'gemini';
    apiKey: string;
    model?: string;
  }): Promise<void> {
    const context = captureAuthenticatedOperation();
    const previousRoute = status.value?.byo ? { ...status.value.byo } : undefined;
    const taskVersion = capabilities.value?.taskVersions?.capabilityTest;
    const request = ++statusRequest;
    assertOperationCurrent(context);
    const next = await context.client.saveAiCredential(input);
    if (taskVersion && previousRoute?.configured) {
      const previousFingerprint = credentialFingerprint(context, previousRoute, taskVersion);
      await aiCredentialTestJournal.clearFingerprint(previousFingerprint).catch(() => undefined);
    }
    if (request !== statusRequest || !operationIsCurrent(context)) return;
    status.value = next;
    statusError.value = null;
  }

  async function deleteCredential(): Promise<void> {
    const context = captureAuthenticatedOperation();
    const previousRoute = status.value?.byo ? { ...status.value.byo } : undefined;
    const taskVersion = capabilities.value?.taskVersions?.capabilityTest;
    const request = ++statusRequest;
    assertOperationCurrent(context);
    const next = await context.client.deleteAiCredential();
    if (taskVersion && previousRoute?.configured) {
      const previousFingerprint = credentialFingerprint(context, previousRoute, taskVersion);
      await aiCredentialTestJournal.clearFingerprint(previousFingerprint).catch(() => undefined);
    }
    if (request !== statusRequest || !operationIsCurrent(context)) return;
    status.value = next;
    // A stored explanation was produced by a key that is now gone; the text
    // stays valid, so there is no reason to throw it away.
  }

  let credentialTestInFlight:
    | { fingerprint: string; promise: Promise<AiCredentialTestResponse> }
    | undefined;

  function credentialFingerprint(
    context: Pick<PaidOperationContext, 'userId' | 'serverBaseUrl' | 'serverCommit'>,
    route: AiStatus['byo'],
    taskVersion: string,
  ): string {
    return aiCacheDigest({
      userId: context.userId,
      serverUrl: context.serverBaseUrl,
      serverCommit: context.serverCommit,
      provider: route.provider,
      model: route.model,
      last4: route.last4,
      credentialRevision: route.credentialRevision ?? 'legacy-unknown',
      taskVersion,
    }).replace(/^v2:/u, '');
  }

  async function testCredential(options: CredentialTestOptions = {}): Promise<AiCredentialTestResponse> {
    const context = captureAuthenticatedOperation();
    const taskVersion = capabilities.value?.taskVersions?.capabilityTest;
    const route = status.value?.byo ? { ...status.value.byo } : undefined;
    if (!canTestCredential.value || !taskVersion || !route?.configured) {
      throw new Error('Der eigene KI-Schlüssel ist nicht testbereit.');
    }
    const fingerprint = credentialFingerprint(context, route, taskVersion);
    if (credentialTestInFlight?.fingerprint === fingerprint) {
      return credentialTestInFlight.promise;
    }
    const promise = (async (): Promise<AiCredentialTestResponse> => {
      // Old servers cannot prove that a same-last4 credential is still the
      // one which produced this tombstone. Retain pending retries, but never
      // replay a completed success without an opaque server revision.
      const completed = route.credentialRevision
        ? await aiCredentialTestJournal.completed(fingerprint)
        : undefined;
      assertOperationCurrent(context);
      if (completed && !options.newRequest) return completed;
      const interactionId = secureRandomUuidV4();
      const base = { interactionId, taskVersion, preferPool: false as const };
      const candidate: AiCredentialTestRequest = {
        ...base,
        clientRequestId: secureRandomUuidV4(),
      };
      // Persist before touching the provider. A reload or a second renderer
      // races through CAS to the same request rather than buying a new probe.
      const pending = options.newRequest
        ? await aiCredentialTestJournal.replace(
            fingerprint,
            options.expectedClientRequestId ?? '',
            candidate,
          )
        : await aiCredentialTestJournal.getOrCreate(fingerprint, candidate);
      assertOperationCurrent(context);
      try {
        const response = await context.client.testAiCredential(pending.request);
        // A paid success must still reach the UI if IndexedDB/quota cleanup
        // fails. A left-over marker then safely yields ALREADY_COMPLETED.
        await aiCredentialTestJournal
          .complete(fingerprint, response)
          .catch(() => undefined);
        assertOperationCurrent(context);
        void refreshStatus();
        return response;
      } catch (error) {
        // Offline/timeout/in-progress retain the durable identity. A known
        // terminal response ends this logical probe; a later click is an
        // explicit new test rather than an accidental network retry.
        if (credentialTestErrorIsTerminal(error)) {
          await aiCredentialTestJournal
            .clear(fingerprint, pending.request.clientRequestId)
            .catch(() => undefined);
        }
        if (
          (error as { code?: unknown })?.code === 'AI_REQUEST_ALREADY_COMPLETED'
          || (error as { code?: unknown })?.code === 'AI_REQUEST_IN_PROGRESS'
        ) {
          Object.assign(error as object, { credentialRequestId: pending.request.clientRequestId });
        }
        throw error;
      }
    })();
    credentialTestInFlight = { fingerprint, promise };
    try {
      return await promise;
    } finally {
      if (credentialTestInFlight?.promise === promise) credentialTestInFlight = undefined;
    }
  }

  /**
   * Keep the status in step with the two things it depends on.
   *
   * It used to be refreshed only by the settings page, on login. That failed
   * twice over: `/info` often lands AFTER the login watch fires, so
   * capabilities were still null and nothing retried — and a user who never
   * opened the settings page never had a status at all, so the drawer never
   * offered an explanation.
   */
  watch(
    [() => auth.isLoggedIn, () => auth.session?.user.id, () => app.config.serverBaseUrl, capabilities],
    () => {
      void refreshStatus();
    },
    { immediate: true, flush: 'sync' },
  );

  /** Never let one account/server identity see another identity's memory map. */
  watch(
    [
      () => auth.session?.user.id,
      () => app.config.serverBaseUrl,
      () => app.serverInfo?.commit,
      () => capabilities.value?.promptVersion,
    ],
    () => {
      explainCache.value = new Map();
      assessCache.value = new Map();
      credentialTestInFlight = undefined;
    },
  );

  /**
   * Prompt preferences live in the app config, so they ride every request and
   * nothing is stored server-side.
   */
  /**
   * One choice, two modes: spend the server's key, or bring your own.
   *
   * Modelled as a single exclusive setting rather than "have a key" plus a
   * separate "prefer pool" flag, because that pair had four states and only
   * three of them meant anything. `pool` is selectable only where the server
   * has actually granted it.
   */
  const sourceAllowed = (source: 'pool' | 'byo'): boolean => {
    if (!available.value || !status.value) return false;
    const explicit = status.value?.allowedSources;
    // Early RC servers did not expose entitlement policy. Preserve their UI
    // behaviour, while every stable v2 server supplies the authoritative list.
    if (!explicit) return source === 'pool' ? status.value?.pool.eligible === true : true;
    return explicit.includes(source);
  };

  const poolAllowed = computed(() => sourceAllowed('pool'));
  const poolOffered = computed(
    () => poolAllowed.value && capabilities.value?.poolAvailable === true
      && status.value?.pool.eligible === true,
  );
  const byoOffered = computed(() => sourceAllowed('byo'));

  const mode = computed<'pool' | 'byo'>(() => {
    const chosen = profilePreferences.value?.preferPool;
    if (chosen === true && sourceAllowed('pool')) return 'pool';
    if (chosen === false && sourceAllowed('byo')) return 'byo';
    // No valid saved choice: follow the server's actual default, then the
    // entitlement policy. A stale preference can never select a forbidden payer.
    if (status.value?.active === 'pool' && sourceAllowed('pool')) return 'pool';
    if (status.value?.active === 'byo' && sourceAllowed('byo')) return 'byo';
    return sourceAllowed('pool') ? 'pool' : 'byo';
  });

  async function setMode(next: 'pool' | 'byo'): Promise<void> {
    if (!sourceAllowed(next)) return;
    const profileId = localProfileStore.currentIfInitialized();
    if (!profileId || !profilePreferencesReady.value) return;
    const stored = await updateProfilePreferences(profileId, { preferPool: next === 'pool' });
    if (localProfileStore.currentIfInitialized() === profileId) profilePreferences.value = stored;
  }

  const customInstructions = computed(() => profilePreferences.value?.customInstructions ?? '');

  async function savePromptPreferences(input: { customInstructions: string }): Promise<void> {
    const profileId = localProfileStore.currentIfInitialized();
    if (!profileId || !profilePreferencesReady.value) {
      throw new Error('Das lokale Profil ist noch nicht bereit.');
    }
    const stored = await updateProfilePreferences(profileId, {
      customInstructions: input.customInstructions,
    });
    if (localProfileStore.currentIfInitialized() === profileId) profilePreferences.value = stored;
  }

  /** The request flag the server reads. */
  const preferPool = computed(() => mode.value === 'pool');

  /** The selected payer must itself be usable; never silently fall back. */
  const selectedSourceReady = computed(() =>
    mode.value === 'pool'
      ? poolOffered.value
      : byoOffered.value && status.value?.byo.configured === true,
  );

  const needsSourceSetup = computed(() => available.value
    && paidProtocolReady.value
    && profilePreferencesReady.value
    && byoOffered.value
    && !selectedSourceReady.value);
  const needsCredentialSetup = computed(() => needsSourceSetup.value
    && status.value?.byo.configured !== true);

  const promptPrefs = computed(() => ({
    preferPool: preferPool.value,
    ...(app.config.aiLanguage ? { language: app.config.aiLanguage } : {}),
    ...(customInstructions.value
      ? { customInstructions: customInstructions.value }
      : {}),
  }));

  function capturePaidOperation(): PaidOperationContext {
    const authContext = captureAuthenticatedOperation();
    if (!canUsePaidSource.value || !paidProtocolReady.value) {
      throw new Error('Die gewählte KI-Quelle ist noch nicht bereit.');
    }
    const source = mode.value;
    const route = source === 'pool' ? status.value?.pool : status.value?.byo;
    const promptVersion = capabilities.value?.promptVersion;
    if (!promptVersion) throw new Error('Der KI-Protokollstand fehlt.');
    const prefs = { ...promptPrefs.value };
    const stable = {
      source,
      promptPrefs: prefs,
    };
    return {
      ...authContext,
      promptVersion,
      source,
      ...(route?.provider ? { provider: route.provider } : {}),
      ...(route?.model ? { model: route.model } : {}),
      promptPrefs: prefs,
      cacheScope: aiCacheDigest({
        version: 1,
        userId: authContext.userId,
        serverUrl: authContext.serverBaseUrl,
      }),
      fingerprint: aiCacheDigest(stable),
    };
  }

  function paidOperationIsCurrent(context: PaidOperationContext): boolean {
    if (!operationIsCurrent(context)) return false;
    const source = mode.value;
    return aiCacheDigest({
      source,
      promptPrefs: { ...promptPrefs.value },
    }) === context.fingerprint;
  }

  function assertPaidOperationCurrent(context: PaidOperationContext): void {
    if (!paidOperationIsCurrent(context)) throw staleRequestError();
  }

  function persistentKey(
    kind: 'explain' | 'assess',
    request: unknown,
    context?: PaidOperationContext,
  ): string {
    const source = context?.source ?? mode.value;
    const route = context ?? (source === 'pool' ? status.value?.pool : status.value?.byo);
    return aiCacheDigest({
      kind,
      userId: context?.userId ?? auth.session?.user.id ?? 'guest',
      serverUrl: context?.serverBaseUrl ?? app.config.serverBaseUrl,
      serverCommit: context
        ? context.serverCommit ?? 'unknown'
        : app.serverInfo?.commit ?? 'unknown',
      promptVersion: context
        ? context.promptVersion
        : capabilities.value?.promptVersion ?? '0',
      source,
      provider: route?.provider,
      model: route?.model,
      request: withoutCacheIdentity(request),
    });
  }

  function cacheScope(): string {
    return aiCacheDigest({
      version: 1,
      userId: auth.session?.user.id ?? 'guest',
      serverUrl: app.config.serverBaseUrl,
    });
  }

  function displayContextKey(
    kind: 'explain' | 'assess',
    request: unknown,
    context?: PaidOperationContext,
  ): string {
    return aiCacheDigest({
      kind,
      userId: context?.userId ?? auth.session?.user.id ?? 'guest',
      serverUrl: context?.serverBaseUrl ?? app.config.serverBaseUrl,
      serverCommit: context
        ? context.serverCommit ?? 'unknown'
        : app.serverInfo?.commit ?? 'unknown',
      promptVersion: context
        ? context.promptVersion
        : capabilities.value?.promptVersion ?? '0',
      source: context?.source ?? mode.value,
      request: withoutCacheIdentity(request),
    });
  }

  /**
   * Fetch (or replay) an explanation.
   *
   * Cached by prompt version + part + the exact answer, because the same wrong
   * answer to the same question recurs — and every miss costs real money.
   */
  async function explain(
    input: ExplainInput,
    signal?: AbortSignal,
    options: PaidAiRequestOptions = {},
  ): Promise<AiExplainResult> {
    const mode = input.mode ?? 'answer';
    if (!featureOffered(mode)) {
      throw new Error('Diese KI-Funktion ist nicht verfügbar.');
    }
    const context = capturePaidOperation();
    const stable = await withStableRequestId(buildExplainRequest({
      ...input,
      mode,
      options: context.promptPrefs,
    }), options, context);
    assertPaidOperationCurrent(context);
    const request = stable.request;
    const key = persistentKey('explain', request, context);
    const displayContext = displayContextKey('explain', request, context);
    const scope = context.cacheScope;

    const inMemory = explainCache.value.get(key);
    if (inMemory) return inMemory;

    let stored: AiExplainResult | undefined;
    const cacheReadGeneration = cacheClearGeneration;
    try {
      const candidate = await aiCache.get<unknown>(key, new Date(), scope);
      if (candidate !== undefined && cacheReadGeneration === cacheClearGeneration) {
        stored = parseCachedAiExplainResponse(
          candidate,
          request,
          capabilities.value?.promptVersion,
        );
      }
    } catch {
      cacheWarning.value = 'Die KI-Antwort konnte lokal nicht gelesen werden.';
    }
    assertPaidOperationCurrent(context);
    if (stored) {
      assertHintDoesNotRevealAnswer(input, stored);
      explainCache.value.set(key, stored);
      return stored;
    }

    const requestCacheGeneration = cacheClearGeneration;
    let cacheWriteToken: number | undefined;
    try {
      cacheWriteToken = await aiCache.captureWriteToken(scope);
    } catch {
      cacheWarning.value = 'Die KI-Antwort kann derzeit nicht lokal gespeichert werden.';
    }
    assertPaidOperationCurrent(context);

    let answer;
    try {
      if (!featureOffered(mode) || !canUsePaidSource.value) {
        throw new Error('Diese KI-Funktion ist nicht verfügbar.');
      }
      // The immutable client carries the token captured before any generation
      // journal/cache await. Never send A's answer using B's live session.
      answer = await context.client.aiExplain(
        request,
        signal,
        context.promptVersion,
      );
    } catch (error) {
      throw annotatePaidRequestFailure(error, stable.generation);
    } finally {
      // Quota/revocation may have changed on either a success or a refusal.
      if (paidOperationIsCurrent(context)) void refreshStatus();
    }
    assertHintDoesNotRevealAnswer(input, answer);
    const reusable = cacheableAiExplainResponse(answer);
    if (requestCacheGeneration === cacheClearGeneration) {
      if (cacheWriteToken !== undefined) {
        try {
          await aiCache.set(key, reusable, new Date(), scope, cacheWriteToken);
          if (requestCacheGeneration === cacheClearGeneration) {
            explainCache.value.set(key, reusable);
            cacheWarning.value = null;
          }
        } catch (error) {
          if (
            !(error instanceof AiCacheWriteInvalidatedError)
            && requestCacheGeneration === cacheClearGeneration
          ) {
            explainCache.value.set(key, reusable);
            cacheWarning.value = 'KI-Antwort sichtbar, aber nicht absturzsicher gespeichert.';
          }
        }
      }
    }
    if (!paidOperationIsCurrent(context) || displayContextKey('explain', request) !== displayContext) {
      throw staleRequestError();
    }
    return answer;
  }

  function explainCacheLocator(
    input: ExplainInput,
    response: AiExplainResult,
    now = new Date(),
  ): AiExplainCacheLocator | undefined {
    const mode = input.mode ?? 'answer';
    if ((mode !== 'hint' && mode !== 'diagnosis') || response.mode !== mode) return undefined;
    const request = buildExplainRequest({ ...input, mode, options: promptPrefs.value });
    const taskVersion = response.taskVersion ?? request.taskVersion;
    if (!taskVersion) return undefined;
    return {
      version: 1,
      cacheKey: persistentKey('explain', request),
      mode,
      ...(mode === 'hint' ? { hintLevel: input.hintLevel } : {}),
      partId: input.part.id,
      attemptPhase: input.identity?.attemptPhase ?? 'first',
      taskVersion,
      promptVersion: response.promptVersion,
      source: response.source,
      savedAt: now.toISOString(),
    } as AiExplainCacheLocator;
  }

  async function replayExplain(
    locator: AiExplainCacheLocator,
    part: QuestionPart,
  ): Promise<AiExplainResult | undefined> {
    if (locator.partId !== part.id) throw new Error('AI cache locator belongs to another part');
    const cacheReadGeneration = cacheClearGeneration;
    const candidate = await aiCache.get<unknown>(locator.cacheKey, new Date(), cacheScope());
    if (cacheReadGeneration !== cacheClearGeneration) return undefined;
    if (candidate === undefined) return undefined;
    const receipt = {
      interactionId: '00000000-0000-4000-8000-000000000000',
      taskVersion: locator.taskVersion,
      contentSource: 'remote' as const,
      contentId: '0'.repeat(40),
      attemptPhase: locator.attemptPhase,
      preferPool: locator.source === 'pool',
    };
    const request: AiExplainRequest = locator.mode === 'hint'
      ? {
          questionId: 'cached',
          partId: 'cached',
          submitted: '',
          maxPoints: 0,
          solutionHasFigures: false,
          ...receipt,
          mode: 'hint',
          hintLevel: locator.hintLevel!,
        }
      : {
          questionId: 'cached',
          partId: 'cached',
          submitted: '',
          maxPoints: 0,
          solutionHasFigures: false,
          ...receipt,
          mode: 'diagnosis',
          verdict: 'incorrect',
          awardedPoints: 0,
        };
    const parsed = parseCachedAiExplainResponse(candidate, request, locator.promptVersion);
    if (
      parsed.mode === 'hint'
      && locator.attemptPhase === 'first'
      && hintRevealsOfficialSolution(
        `${parsed.hint.markdown}\n${parsed.hint.nextAction}`,
        part,
      )
    ) {
      const error = new Error('Der gespeicherte Hinweis würde die Lösung vorwegnehmen.');
      Object.assign(error, { code: 'AI_HINT_REVEALS_SOLUTION' });
      throw error;
    }
    return parsed;
  }

  /**
   * Ask for per-criterion verdicts.
   *
   * Returns null when the part is not AI-gradable at all, so callers do not
   * have to repeat the gate. The response is a SUGGESTION — applying it is the
   * caller's job, and committing it is the user's.
   */
  async function assess(
    input: AssessInput,
    signal?: AbortSignal,
    options: PaidAiRequestOptions = {},
  ): Promise<AiAssessResult | null> {
    if (!buildAssessRequest({ ...input, options: {} })) return null;
    if (!canAssess(input.part, input.question)) {
      throw new Error('Diese KI-Funktion ist nicht verfügbar.');
    }
    const context = capturePaidOperation();
    const projected = buildAssessRequest({ ...input, options: context.promptPrefs });
    if (!projected) return null;
    const stable = await withStableRequestId(projected, options, context);
    assertPaidOperationCurrent(context);
    const request = stable.request;
    const key = persistentKey('assess', request, context);
    const displayContext = displayContextKey('assess', request, context);
    const scope = context.cacheScope;
    const inMemory = assessCache.value.get(key);
    if (inMemory) return inMemory;
    let stored: AiAssessResult | undefined;
    const cacheReadGeneration = cacheClearGeneration;
    try {
      const candidate = await aiCache.get<unknown>(key, new Date(), scope);
      if (candidate !== undefined && cacheReadGeneration === cacheClearGeneration) {
        stored = parseCachedAiAssessResponse(
          candidate,
          request,
          capabilities.value?.promptVersion,
        );
      }
    } catch {
      cacheWarning.value = 'Die KI-Antwort konnte lokal nicht gelesen werden.';
    }
    assertPaidOperationCurrent(context);
    if (stored) {
      assessCache.value.set(key, stored);
      return stored;
    }
    const requestCacheGeneration = cacheClearGeneration;
    let cacheWriteToken: number | undefined;
    try {
      cacheWriteToken = await aiCache.captureWriteToken(scope);
    } catch {
      cacheWarning.value = 'Die KI-Antwort kann derzeit nicht lokal gespeichert werden.';
    }
    assertPaidOperationCurrent(context);
    let answer;
    try {
      if (!canAssess(input.part, input.question)) {
        throw new Error('Diese KI-Funktion ist nicht verfügbar.');
      }
      answer = await context.client.aiAssess(
        request,
        signal,
        context.promptVersion,
      );
    } catch (error) {
      throw annotatePaidRequestFailure(error, stable.generation);
    } finally {
      if (paidOperationIsCurrent(context)) void refreshStatus();
    }
    const reusable = cacheableAiAssessResponse(answer);
    if (requestCacheGeneration === cacheClearGeneration) {
      if (cacheWriteToken !== undefined) {
        try {
          await aiCache.set(key, reusable, new Date(), scope, cacheWriteToken);
          if (requestCacheGeneration === cacheClearGeneration) {
            assessCache.value.set(key, reusable);
            cacheWarning.value = null;
          }
        } catch (error) {
          if (
            !(error instanceof AiCacheWriteInvalidatedError)
            && requestCacheGeneration === cacheClearGeneration
          ) {
            assessCache.value.set(key, reusable);
            cacheWarning.value = 'KI-Antwort sichtbar, aber nicht absturzsicher gespeichert.';
          }
        }
      }
    }
    if (!paidOperationIsCurrent(context) || displayContextKey('assess', request) !== displayContext) {
      throw staleRequestError();
    }
    return answer;
  }

  function assessCacheLocator(
    input: AssessInput,
    response: AiAssessResult,
    now = new Date(),
  ): AiAssessCacheLocator | undefined {
    const request = buildAssessRequest({ ...input, options: promptPrefs.value });
    if (
      !request
      || !input.identity?.contentSource
      || !input.identity.contentId
      || !input.identity.attemptPhase
    ) return undefined;
    const taskVersion = response.taskVersion ?? request.taskVersion;
    if (!taskVersion) return undefined;
    return {
      version: 1,
      cacheKey: persistentKey('assess', request),
      requestDigest: aiCacheDigest({ version: 1, request: withoutCacheIdentity(request) }),
      partId: input.part.id,
      attemptPhase: input.identity.attemptPhase,
      contentSource: input.identity.contentSource,
      contentId: input.identity.contentId,
      taskVersion,
      promptVersion: response.promptVersion,
      source: response.source,
      savedAt: now.toISOString(),
    };
  }

  async function replayAssess(
    locator: AiAssessCacheLocator,
    input: AssessInput,
  ): Promise<AiAssessResult | undefined> {
    if (locator.partId !== input.part.id) throw new Error('AI assessment belongs to another part');
    const request = buildAssessRequest({
      ...input,
      identity: {
        interactionId: '00000000-0000-4000-8000-000000000000',
        taskVersion: locator.taskVersion,
        contentSource: locator.contentSource,
        contentId: locator.contentId,
        attemptPhase: locator.attemptPhase,
      },
      options: {
        ...promptPrefs.value,
        preferPool: locator.source === 'pool',
      },
    });
    if (!request) throw new Error('AI assessment is no longer valid for this part');
    if (aiCacheDigest({ version: 1, request: withoutCacheIdentity(request) }) !== locator.requestDigest) {
      throw new Error('AI assessment no longer matches this answer');
    }
    const cacheReadGeneration = cacheClearGeneration;
    const candidate = await aiCache.get<unknown>(locator.cacheKey, new Date(), cacheScope());
    if (cacheReadGeneration !== cacheClearGeneration) return undefined;
    if (candidate === undefined) return undefined;
    return parseCachedAiAssessResponse(candidate, request, locator.promptVersion);
  }

  /**
   * Synchronous read for rendering. Only sees the in-memory layer, which is
   * what `explain()` fills on the way through — the panel asks for an answer
   * before it shows one, so the stored layer is always promoted by then.
   */
  function cached(input: ExplainInput): AiExplainResult | undefined {
    const mode = input.mode ?? 'answer';
    const request = buildExplainRequest({
      ...input,
      mode,
      options: promptPrefs.value,
    });
    return explainCache.value.get(persistentKey('explain', request));
  }

  /** Belongs next to „Schlüssel entfernen": forgetting should mean all of it. */
  async function clearCache(): Promise<void> {
    beginCacheClear();
    await aiCache.clear(cacheScope());
  }

  return {
    capabilities,
    status,
    statusError,
    available,
    canExplain,
    canHint,
    canDiagnose,
    hintOffered,
    diagnosisOffered,
    assessmentOffered,
    needsSourceSetup,
    needsCredentialSetup,
    canTestCredential,
    configured,
    poolOnlyServer,
    mode,
    setMode,
    customInstructions,
    savePromptPreferences,
    profilePreferencesReady,
    poolAllowed,
    poolOffered,
    byoOffered,
    refreshStatus,
    saveCredential,
    deleteCredential,
    testCredential,
    explain,
    explainCacheLocator,
    replayExplain,
    assessCacheLocator,
    replayAssess,
    clearCache,
    canAssess,
    canLearn,
    assess,
    cached,
    cacheWarning,
    paidProtocolReady,
  };
});

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

function credentialTestErrorIsTerminal(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (
    code === 'AI_REQUEST_IN_PROGRESS'
    || code === 'AI_REQUEST_ALREADY_COMPLETED'
    || code === 'AI_REQUEST_STATE_CONFLICT'
  ) return false;
  if (
    code === 'AI_REQUEST_ID_REUSED'
    || code === 'AI_TASK_VERSION_MISMATCH'
    || code === 'AI_NO_CREDENTIAL'
    || code === 'AI_KEY_REJECTED'
    || code === 'AI_CREDENTIAL_CHANGED'
    || code === 'AI_NOT_ENTITLED'
  ) return true;
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number'
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429;
}

function staleRequestError(): Error {
  const error = new Error('AI request context changed');
  error.name = 'AbortError';
  return error;
}

function assertHintDoesNotRevealAnswer(input: ExplainInput, response: AiExplainResult): void {
  if (
    (input.mode ?? 'answer') !== 'hint'
    || input.identity?.attemptPhase !== 'first'
    || response.mode !== 'hint'
    || !hintRevealsOfficialSolution(
      `${response.hint.markdown}\n${response.hint.nextAction}`,
      input.part,
    )
  ) return;
  const error = new Error('Dieser Hinweis würde die Lösung vorwegnehmen und wurde nicht angezeigt.');
  error.name = 'AiHintSafetyError';
  Object.assign(error, { code: 'AI_HINT_REVEALS_SOLUTION' });
  throw error;
}

/** Correlation ids make retries safe, but do not change the paid answer's content. */
function withoutCacheIdentity(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const stable = { ...(request as Record<string, unknown>) };
  delete stable.clientRequestId;
  delete stable.interactionId;
  return stable;
}

function withoutClientRequestId(request: unknown): unknown {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const stable = { ...(request as Record<string, unknown>) };
  delete stable.clientRequestId;
  return stable;
}

async function withStableRequestId<T extends { interactionId?: string; taskVersion?: string }>(
  request: T,
  options: PaidAiRequestOptions = {},
  context?: Pick<PaidOperationContext, 'userId' | 'serverBaseUrl' | 'serverCommit'>,
): Promise<StablePaidRequest<T & { clientRequestId?: string }>> {
  if (!request.interactionId || !request.taskVersion) return { request };
  const app = context ? undefined : useAppStore();
  const auth = context ? undefined : useAuthStore();
  const logical = aiCacheDigest({
    userId: context?.userId ?? auth?.session?.user.id ?? 'guest',
    serverUrl: context?.serverBaseUrl ?? app?.config.serverBaseUrl,
    serverCommit: context
      ? context.serverCommit ?? 'unknown'
      : app?.serverInfo?.commit ?? 'unknown',
    request: withoutClientRequestId(request),
  }).replace(/^v2:/u, '');
  const identity = options.newRequest === true
    ? await aiRequestGenerationJournal.advance(
        logical,
        requireExpectedGeneration(options.expectedGeneration),
      )
    : await aiRequestGenerationJournal.current(logical);
  return {
    generation: identity.generation,
    request: {
      ...request,
      clientRequestId: identity.clientRequestId,
    },
  };
}

function requireExpectedGeneration(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('A confirmed paid-request generation is required');
  }
  return value as number;
}

function annotatePaidRequestFailure(error: unknown, generation: number | undefined): unknown {
  if (generation === undefined || !(error instanceof Error)) return error;
  Object.defineProperty(error, 'paidRequestGeneration', {
    value: generation,
    configurable: true,
    enumerable: false,
  });
  return error;
}
