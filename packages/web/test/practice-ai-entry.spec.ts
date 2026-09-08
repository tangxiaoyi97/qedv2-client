import 'fake-indexeddb/auto';
import { createApp, defineComponent, h, nextTick, onMounted } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountStorageIdentity, STORAGE, type AiCapabilities, type AiExplainCacheLocator, type AiStatus, type Question } from '@qed2/core-logic';
import type { PartPlayerState } from '@qed2/ui';
import PracticeView from '../src/routes/PracticeView.vue';
import { localProfileStore, storage } from '../src/services.js';
import { useAiStore } from '../src/stores/ai.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const player = vi.hoisted(() => ({ emit: undefined as ((state: PartPlayerState) => void) | undefined }));
vi.mock('@qed2/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@qed2/ui')>(),
  PartPlayer: defineComponent({
    emits: ['state'],
    setup(_, { emit }) {
      onMounted(() => { player.emit = (state) => emit('state', state); });
      return () => h('div', { class: 'test-player' });
    },
  }),
}));

const caps: AiCapabilities = {
  explain: true, assess: true, hint: true, diagnosis: true, promptVersion: 'v2',
  providers: ['openai'], poolAvailable: true, idempotencyWindowDays: 400,
  taskVersions: { hint: 'hint.v1', diagnosis: 'diagnosis.v1', assess: 'assess.v1', answer: 'answer.v1' },
};
const ready: AiStatus = {
  byo: { configured: false }, pool: { eligible: true, provider: 'openai' },
  active: 'pool', allowedSources: ['pool'],
  features: { explain: true, assess: true, hint: true, diagnosis: true },
};
const question: Question = {
  id: 'q1', schemaVersion: 3, status: 'reviewed', lang: 'de', title: 'Beispiel',
  source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr: 1, file: 'q1.yaml' },
  parts: [{
    id: 'q1-a', label: 'a', points: 1, competencies: [],
    answer: { kind: 'open', grader: 'ai', rubric: [{ t: 'text', v: 'Begründen' }] },
    scoring: { mode: 'allOrNothing', points: 1 },
  }],
};
function state(verdict?: 'correct' | 'incorrect'): PartPlayerState {
  const result = verdict ? { verdict, correct: verdict === 'correct', maxPoints: 1, awardedPoints: verdict === 'correct' ? 1 : 0 } : null;
  return {
    phase: verdict ? 'reviewed' : 'answering', attemptPhase: 'first', canSubmit: false,
    result, firstResult: result, indeterminate: false, unplayable: false,
    answerPreview: null, submittedText: verdict ? 'x = 3' : '', selfAssessment: null,
  };
}
async function settle() {
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick(); }
}
let unmount: (() => void) | undefined;
async function mountPractice(status = ready, options: { enabled?: boolean; loggedIn?: boolean; cached?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = useAppStore();
  app.config = { ...app.config, serverBaseUrl: 'https://ai.test' };
  app.serverInfo = {
    service: 'qed2-server', version: '2.3.2', sourceRepo: 'repo', buildTime: '2026-09-08', auth: 'jwt',
    ...(options.enabled !== false ? { ai: caps } : {}),
  };
  if (options.loggedIn !== false) {
    useAuthStore().session = {
      user: { id: 'u1', username: 'student' }, token: 'test-token',
      expiresAt: '2099-01-01T00:00:00Z', serverBaseUrl: 'https://ai.test',
    };
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/me/ai/status')) {
      return new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${input}`);
  }));
  await useProgressStore().init();
  const practice = usePracticeStore();
  vi.spyOn(practice, 'restoreSession').mockResolvedValue(true);
  practice.$patch({
    phase: 'running', sessionIdentityDurable: true, contentId: 'a'.repeat(40),
    questions: new Map([['q1', question]]),
    items: [{
      questionId: 'q1', partId: 'q1-a', reason: 'manual',
      learningInteractionId: '11111111-1111-4111-8111-111111111111',
      ...(options.cached ? { cachedAiHint: { cacheKey: 'cached', partId: 'q1-a', mode: 'hint' } as AiExplainCacheLocator } : {}),
    }],
  });
  const ai = useAiStore();
  if (options.cached) vi.spyOn(ai, 'replayExplain').mockResolvedValue({
    mode: 'hint', markdown: 'Gespeicherte KI-Antwort',
    hint: { level: 1, markdown: 'Gespeicherte KI-Antwort', nextAction: 'Denke weiter', advisoryOnly: true },
    model: 'test-model', promptVersion: 'v2', source: 'pool', taskVersion: 'hint.v1', cached: true,
  });
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/practice', component: PracticeView },
    { path: '/settings', component: { template: '<div id="ai-settings" />' } },
  ] });
  await router.push('/practice');
  const host = document.createElement('div');
  document.body.append(host);
  const view = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
  view.mount(host);
  unmount = () => view.unmount();
  await settle();
  return { host, ai, app, router };
}

describe('practice AI entries', () => {
  beforeEach(async () => {
    await storage.clear(STORAGE.config);
    await localProfileStore.initialize(accountStorageIdentity('https://ai.test', 'u1'));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    unmount?.(); unmount = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '';
  });

  it.each([{ enabled: false }, { loggedIn: false }])('has no AI or setup entry when unavailable: %o', async (options) => {
    const { host, ai } = await mountPractice(ready, options);
    ai.status = ready;
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
    expect(host.textContent).not.toContain('KI einrichten');
    expect(host.querySelector('.q-aia')).toBeNull();
  });

  it('uses an authorized pool directly and offers BYO setup only in the hint context', async () => {
    const { host, ai, app, router } = await mountPractice();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    expect(host.querySelector('.practice-bar__learning-toggle')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(host.textContent).toContain('Hinweis 1');
    expect(host.textContent).not.toContain('KI einrichten');
    ai.status = { ...ready, active: 'none', allowedSources: ['byo'], pool: { eligible: false } };
    await settle();
    expect(host.textContent).toContain('KI einrichten');
    expect(host.textContent).not.toContain('Hinweis 1');
    app.serverInfo = { ...app.serverInfo!, ai: { ...caps, hint: false, explain: false, diagnosis: false } };
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
    expect(router.currentRoute.value.path).toBe('/practice');
  });

  it('hides a cached AI hint after global disable but retains a clean, non-AI correction action', async () => {
    const { host, app, ai } = await mountPractice(ready, { cached: true });
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')?.click();
    await settle();
    expect(host.textContent).toContain('Gespeicherte KI-Antwort');
    ai.cacheWarning = 'KI-Cache warnung';
    app.serverInfo = { ...app.serverInfo!, ai: undefined };
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
    expect(host.textContent).not.toContain('Gespeicherte KI-Antwort');
    player.emit!(state('incorrect'));
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')?.textContent).toContain('Korrektur');
    expect(host.querySelector('.q-learning h3')?.textContent).toBe('Korrektur');
    expect(host.querySelector('.q-learning')?.textContent).not.toContain('KI');
    expect(host.querySelector('.q-learning__loading, .q-learning__storage, .q-aibadge')).toBeNull();
    player.emit!(state('correct'));
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
  });

  it('opens the precise setup section without changing the practice or choosing a payer', async () => {
    const { host, ai, router } = await mountPractice({
      ...ready, active: 'none', allowedSources: ['byo'], pool: { eligible: false },
    });
    await vi.waitFor(() => expect(ai.needsCredentialSetup).toBe(true));
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    const before = usePracticeStore().items.map((item) => ({ ...item }));
    const choose = vi.spyOn(ai, 'setMode');
    const button = [...host.querySelectorAll<HTMLButtonElement>('.q-learning__actions button')]
      .find((entry) => entry.textContent?.includes('KI einrichten'));
    expect(button).toBeDefined();
    button!.click();
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/settings#ai-settings'));
    expect(usePracticeStore().items).toEqual(before);
    expect(usePracticeStore().contentId).toBe('a'.repeat(40));
    expect(choose).not.toHaveBeenCalled();
  });
});
