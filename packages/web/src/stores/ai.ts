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

  /**
   * Answers already fetched.
   *
   * Two layers: a Map so a re-render is instant, and AiCache behind it so a
   * reload does not buy the same explanation twice. The Map used to be the
   * only layer, which made the cache worth very little — the commonest way to
   * look at an explanation again is to come back to the question later.
   */
  const cache = ref(new Map<string, AiExplainResponse>());

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
      status.value.active !== 'none',
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
  const available = computed(() => auth.isLoggedIn && capabilities.value !== null);

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
      status.value.active !== 'none' &&
      isAiGradable(part)
    );
  }

  async function refreshStatus(): Promise<void> {
    if (!auth.isLoggedIn || capabilities.value === null) {
      status.value = null;
      return;
    }
    try {
      status.value = await app.serverClient.aiStatus();
      statusError.value = null;
    } catch (e) {
      status.value = null;
      statusError.value = messageOf(e);
    }
  }

  async function saveCredential(input: {
    provider: 'openai' | 'gemini';
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }): Promise<void> {
    status.value = await app.serverClient.saveAiCredential(input);
    statusError.value = null;
  }

  async function deleteCredential(): Promise<void> {
    status.value = await app.serverClient.deleteAiCredential();
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
    [() => auth.isLoggedIn, capabilities],
    () => {
      void refreshStatus();
    },
    { immediate: true },
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
  const poolOffered = computed(() => status.value?.pool.eligible === true);

  const mode = computed<'pool' | 'byo'>(() => {
    const chosen = app.config.aiPreferPool;
    // Never chosen: follow what actually works. An account granted the pool
    // and holding no key of its own opened the settings to find the mode it
    // cannot use already selected.
    if (chosen === undefined) return poolOffered.value ? 'pool' : 'byo';
    return chosen && poolOffered.value ? 'pool' : 'byo';
  });

  function setMode(next: 'pool' | 'byo'): void {
    if (next === 'pool' && !poolOffered.value) return;
    void app.updateConfig({ aiPreferPool: next === 'pool' });
  }

  /** The request flag the server reads. */
  const preferPool = computed(() => mode.value === 'pool');

  const promptPrefs = computed(() => ({
    ...(preferPool.value ? { preferPool: true } : {}),
    ...(app.config.aiLanguage ? { language: app.config.aiLanguage } : {}),
    ...(app.config.aiCustomInstructions
      ? { customInstructions: app.config.aiCustomInstructions }
      : {}),
  }));

  /**
   * Cache key. Includes the mode and the preferences: asking for a walkthrough
   * after an explanation, or switching language, must not replay the old text.
   */
  function cacheKey(partId: string, submitted: string, mode: AiExplainMode): string {
    const prefs = `${app.config.aiLanguage ?? ''}~${app.config.aiCustomInstructions ?? ''}`;
    return `${capabilities.value?.promptVersion ?? '0'}|${mode}|${partId}|${submitted}|${prefs}`;
  }

  /**
   * Fetch (or replay) an explanation.
   *
   * Cached by prompt version + part + the exact answer, because the same wrong
   * answer to the same question recurs — and every miss costs real money.
   */
  async function explain(input: {
    question: Question;
    part: QuestionPart;
    submitted: string;
    result: GradeResult;
    mode?: AiExplainMode;
  }): Promise<AiExplainResponse> {
    const mode = input.mode ?? 'answer';
    const key = cacheKey(input.part.id, input.submitted, mode);

    const inMemory = cache.value.get(key);
    if (inMemory) return inMemory;

    const stored = await aiCache.get<AiExplainResponse>(key);
    if (stored) {
      cache.value.set(key, stored);
      return stored;
    }

    const answer = await app.serverClient.aiExplain(
      buildExplainRequest({ ...input, mode, options: promptPrefs.value }),
    );
    cache.value.set(key, answer);
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
  }): Promise<AiAssessResponse | null> {
    const request = buildAssessRequest(input);
    if (!request) return null;
    return app.serverClient.aiAssess({ ...request, ...promptPrefs.value });
  }

  /**
   * Synchronous read for rendering. Only sees the in-memory layer, which is
   * what `explain()` fills on the way through — the panel asks for an answer
   * before it shows one, so the stored layer is always promoted by then.
   */
  function cached(
    partId: string,
    submitted: string,
    mode: AiExplainMode = 'answer',
  ): AiExplainResponse | undefined {
    return cache.value.get(cacheKey(partId, submitted, mode));
  }

  /** Belongs next to „Schlüssel entfernen": forgetting should mean all of it. */
  async function clearCache(): Promise<void> {
    cache.value = new Map();
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
    poolOffered,
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
