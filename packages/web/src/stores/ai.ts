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
  type AiExplainResponse,
  type AiStatus,
  type GradeResult,
  type Question,
  type QuestionPart,
} from '@qed2/core-logic';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

/** How many explanations to keep. Small: they are per-answer and rarely revisited. */
const CACHE_LIMIT = 60;

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

  /** Answers already fetched, keyed by prompt version + part + submission. */
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

  /** True when the server has AI at all — drives whether settings shows the section. */
  const available = computed(() => capabilities.value !== null);

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

  function cacheKey(partId: string, submitted: string): string {
    return `${capabilities.value?.promptVersion ?? '0'}|${partId}|${submitted}`;
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
  }): Promise<AiExplainResponse> {
    const key = cacheKey(input.part.id, input.submitted);
    const hit = cache.value.get(key);
    if (hit) return hit;

    const answer = await app.serverClient.aiExplain(buildExplainRequest(input));
    cache.value.set(key, answer);
    // Oldest-first eviction; Map preserves insertion order.
    if (cache.value.size > CACHE_LIMIT) {
      const oldest = cache.value.keys().next().value;
      if (oldest !== undefined) cache.value.delete(oldest);
    }
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
    return app.serverClient.aiAssess(request);
  }

  function cached(partId: string, submitted: string): AiExplainResponse | undefined {
    return cache.value.get(cacheKey(partId, submitted));
  }

  return {
    capabilities,
    status,
    statusError,
    available,
    canExplain,
    poolOnlyServer,
    refreshStatus,
    saveCredential,
    deleteCredential,
    explain,
    canAssess,
    assess,
    cached,
  };
});

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}
