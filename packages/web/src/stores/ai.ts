/**
 * AI state: what this server can do, what this account may use, and a cache of
 * answers already paid for.
 *
 * Everything here degrades to "off". A server with no `ai` block in `GET /info`
 * — an older one, or one with the flags down — leaves every AI entry point
 * unrendered rather than showing something that then fails.
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  aiCacheDigest,
  buildAssessRequest,
  buildExplainRequest,
  isAiGradable,
  type AiAssessResponse,
  type AiCapabilities,
  type AiExplainMode,
  type AiExplainResponse,
  type AiStatus,
  type GradeResult,
  type Question,
  type QuestionPart,
} from '@qed2/core-logic';
import { aiCache } from '../services.js';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

interface ExplainInput {
  question: Question;
  part: QuestionPart;
  submitted: string;
  result: GradeResult;
  mode?: AiExplainMode;
}

export const useAiStore = defineStore('ai', () => {
  const app = useAppStore();
  const auth = useAuthStore();

  /**
   * Derived from the `/info` the app store already fetches — one probe, not
   * two. Absent block ⇒ this server has no AI, and every entry point stays
   * unrendered.
   */
  const capabilities = computed<AiCapabilities | null>(() => app.serverInfo?.ai ?? null);

  const status = ref<AiStatus | null>(null);
  const statusError = ref<string | null>(null);
  let statusRequest = 0;

  /**
   * Answers already fetched.
   *
   * Two layers: a Map so a re-render is instant, and AiCache behind it so a
   * reload does not buy the same explanation twice. The Map used to be the
   * only layer, which made the cache worth very little — the commonest way to
   * look at an explanation again is to come back to the question later.
   */
  const explainCache = ref(new Map<string, AiExplainResponse>());
  const assessCache = ref(new Map<string, AiAssessResponse>());

  /**
   * Explanation is offered only when the server has it switched on AND the
   * account can actually pay for it. Showing a button that always 402s is
   * worse than showing nothing.
   */
  const canExplain = computed(
    () =>
      auth.isLoggedIn &&
      capabilities.value?.explain === true &&
      status.value !== null &&
      status.value.features.explain === true &&
      status.value.active !== 'none' &&
      selectedSourceReady.value,
  );

  /** Nothing works until one of the two modes is actually usable. */
  const configured = computed(
    () => poolOffered.value || status.value?.byo.configured === true,
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
      capabilities.value !== null &&
      (capabilities.value.explain || capabilities.value.assess),
  );

  const poolOnlyServer = computed(() => capabilities.value?.poolAvailable === true);

  /**
   * Whether an AI verdict may even be requested for this part.
   *
   * Three gates, and the bank owns the first one: `grader: 'ai'` is per
   * question, so the content decides which rubrics are good enough to judge
   * against. The client never overrides that.
   */
  function canAssess(part: QuestionPart): boolean {
    return (
      auth.isLoggedIn &&
      capabilities.value?.assess === true &&
      status.value !== null &&
      status.value.features.assess === true &&
      status.value.active !== 'none' &&
      selectedSourceReady.value &&
      isAiGradable(part)
    );
  }

  async function refreshStatus(): Promise<void> {
    const request = ++statusRequest;
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
    const request = ++statusRequest;
    const next = await app.serverClient.saveAiCredential(input);
    if (request !== statusRequest) return;
    status.value = next;
    statusError.value = null;
  }

  async function deleteCredential(): Promise<void> {
    const request = ++statusRequest;
    const next = await app.serverClient.deleteAiCredential();
    if (request !== statusRequest) return;
    status.value = next;
    // A stored explanation was produced by a key that is now gone; the text
    // stays valid, so there is no reason to throw it away.
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
    { immediate: true },
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
    const explicit = status.value?.allowedSources;
    // Early RC servers did not expose entitlement policy. Preserve their UI
    // behaviour, while every stable v2 server supplies the authoritative list.
    if (!explicit) return source === 'pool' ? status.value?.pool.eligible === true : true;
    return explicit.includes(source);
  };

  const poolAllowed = computed(() => sourceAllowed('pool'));
  const poolOffered = computed(
    () => poolAllowed.value && status.value?.pool.eligible === true,
  );
  const byoOffered = computed(() => sourceAllowed('byo'));

  const mode = computed<'pool' | 'byo'>(() => {
    const chosen = app.config.aiPreferPool;
    if (chosen === true && sourceAllowed('pool')) return 'pool';
    if (chosen === false && sourceAllowed('byo')) return 'byo';
    // No valid saved choice: follow the server's actual default, then the
    // entitlement policy. A stale preference can never select a forbidden payer.
    if (status.value?.active === 'pool' && sourceAllowed('pool')) return 'pool';
    if (status.value?.active === 'byo' && sourceAllowed('byo')) return 'byo';
    return sourceAllowed('pool') ? 'pool' : 'byo';
  });

  function setMode(next: 'pool' | 'byo'): void {
    if (!sourceAllowed(next)) return;
    void app.updateConfig({ aiPreferPool: next === 'pool' });
  }

  /** The request flag the server reads. */
  const preferPool = computed(() => mode.value === 'pool');

  /** The selected payer must itself be usable; never silently fall back. */
  const selectedSourceReady = computed(() =>
    mode.value === 'pool'
      ? poolOffered.value
      : byoOffered.value && status.value?.byo.configured === true,
  );

  const promptPrefs = computed(() => ({
    preferPool: preferPool.value,
    ...(app.config.aiLanguage ? { language: app.config.aiLanguage } : {}),
    ...(app.config.aiCustomInstructions
      ? { customInstructions: app.config.aiCustomInstructions }
      : {}),
  }));

  function persistentKey(kind: 'explain' | 'assess', request: unknown): string {
    const source = mode.value;
    const route = source === 'pool' ? status.value?.pool : status.value?.byo;
    return aiCacheDigest({
      kind,
      userId: auth.session?.user.id ?? 'guest',
      serverUrl: app.config.serverBaseUrl,
      serverCommit: app.serverInfo?.commit ?? 'unknown',
      promptVersion: capabilities.value?.promptVersion ?? '0',
      source,
      provider: route?.provider,
      model: route?.model,
      request,
    });
  }

  function isCurrentKey(kind: 'explain' | 'assess', request: unknown, key: string): boolean {
    return persistentKey(kind, request) === key;
  }

  /**
   * Fetch (or replay) an explanation.
   *
   * Cached by prompt version + part + the exact answer, because the same wrong
   * answer to the same question recurs — and every miss costs real money.
   */
  async function explain(input: ExplainInput, signal?: AbortSignal): Promise<AiExplainResponse> {
    const mode = input.mode ?? 'answer';
    const request = buildExplainRequest({ ...input, mode, options: promptPrefs.value });
    const key = persistentKey('explain', request);

    const inMemory = explainCache.value.get(key);
    if (inMemory) return inMemory;

    const stored = await aiCache.get<AiExplainResponse>(key);
    if (!isCurrentKey('explain', request, key)) throw staleRequestError();
    if (stored) {
      explainCache.value.set(key, stored);
      return stored;
    }

    let answer: AiExplainResponse;
    try {
      answer = await app.serverClient.aiExplain(request, signal);
    } finally {
      // Quota/revocation may have changed on either a success or a refusal.
      void refreshStatus();
    }
    if (!isCurrentKey('explain', request, key)) throw staleRequestError();
    explainCache.value.set(key, answer);
    await aiCache.set(key, answer);
    return answer;
  }

  /**
   * Ask for per-criterion verdicts.
   *
   * Returns null when the part is not AI-gradable at all, so callers do not
   * have to repeat the gate. The response is a SUGGESTION — applying it is the
   * caller's job, and committing it is the user's.
   */
  async function assess(input: {
    question: Question;
    part: QuestionPart;
    submitted: string;
    maxPoints: number;
    /** Point values the part allows — used when it has no scored criteria. */
    scoreOptions?: number[];
  }, signal?: AbortSignal): Promise<AiAssessResponse | null> {
    const request = buildAssessRequest({ ...input, options: promptPrefs.value });
    if (!request) return null;
    const key = persistentKey('assess', request);
    const inMemory = assessCache.value.get(key);
    if (inMemory) return inMemory;
    const stored = await aiCache.get<AiAssessResponse>(key);
    if (!isCurrentKey('assess', request, key)) throw staleRequestError();
    if (stored) {
      assessCache.value.set(key, stored);
      return stored;
    }
    let answer: AiAssessResponse;
    try {
      answer = await app.serverClient.aiAssess(request, signal);
    } finally {
      void refreshStatus();
    }
    if (!isCurrentKey('assess', request, key)) throw staleRequestError();
    assessCache.value.set(key, answer);
    await aiCache.set(key, answer);
    return answer;
  }

  /**
   * Synchronous read for rendering. Only sees the in-memory layer, which is
   * what `explain()` fills on the way through — the panel asks for an answer
   * before it shows one, so the stored layer is always promoted by then.
   */
  function cached(input: ExplainInput): AiExplainResponse | undefined {
    const mode = input.mode ?? 'answer';
    const request = buildExplainRequest({ ...input, mode, options: promptPrefs.value });
    return explainCache.value.get(persistentKey('explain', request));
  }

  /** Belongs next to „Schlüssel entfernen": forgetting should mean all of it. */
  async function clearCache(): Promise<void> {
    explainCache.value = new Map();
    assessCache.value = new Map();
    await aiCache.clear();
  }

  return {
    capabilities,
    status,
    statusError,
    available,
    canExplain,
    configured,
    poolOnlyServer,
    mode,
    setMode,
    poolAllowed,
    poolOffered,
    byoOffered,
    refreshStatus,
    saveCredential,
    deleteCredential,
    explain,
    clearCache,
    canAssess,
    assess,
    cached,
  };
});

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}

function staleRequestError(): Error {
  const error = new Error('AI request context changed');
  error.name = 'AbortError';
  return error;
}
