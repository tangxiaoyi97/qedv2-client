import 'fake-indexeddb/auto';
import { createApp, defineComponent, h, nextTick, onMounted } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountStorageIdentity, STORAGE, type AiAssessResult, type AiCapabilities, type AiExplainCacheLocator, type AiStatus, type Question } from '@qed2/core-logic';
import type { PartPlayerDraft, PartPlayerState } from '@qed2/ui';
import PracticeView from '../src/routes/PracticeView.vue';
import { localProfileStore, storage } from '../src/services.js';
import { useAiStore } from '../src/stores/ai.js';
import { useAppStore } from '../src/stores/app.js';
import { useAuthStore } from '../src/stores/auth.js';
import { usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const player = vi.hoisted(() => ({
  emit: undefined as ((state: PartPlayerState) => void) | undefined,
  draft: undefined as ((draft: PartPlayerDraft) => void) | undefined,
}));
vi.mock('@qed2/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@qed2/ui')>(),
  PartPlayer: defineComponent({
    emits: ['state', 'draft'],
    setup(_, { emit }) {
      onMounted(() => {
        player.emit = (state) => emit('state', state);
        player.draft = (draft) => emit('draft', draft);
      });
      return () => h('div', { class: 'test-player' });
    },
  }),
}));

const caps: AiCapabilities = {
  explain: true, assess: true, hint: true, diagnosis: true, promptVersion: 'v2',
  providers: ['openai'], poolAvailable: true, idempotencyWindowDays: 400,
  taskVersions: { walkthrough: 'walkthrough.v1', hint: 'hint.v1', diagnosis: 'diagnosis.v1', assess: 'assess.v1', answer: 'answer.v1' },
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
    phase: verdict ? 'reviewed' : 'answering', canSubmit: false,
    result, indeterminate: false, unplayable: false,
    answerPreview: null, submittedText: verdict ? 'x = 3' : '', selfAssessment: null,
  };
}
async function settle() {
  for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick(); }
}
let unmount: (() => void) | undefined;
async function mountPractice(status = ready, options: { enabled?: boolean; loggedIn?: boolean; cached?: boolean; legacyCorrectionCache?: boolean } = {}) {
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
      ...(options.cached ? { cachedAiHint: {
        cacheKey: 'cached', partId: 'q1-a', mode: 'hint',
        attemptPhase: options.legacyCorrectionCache ? 'correction' : 'first',
      } as AiExplainCacheLocator } : {}),
    }],
  });
  const ai = useAiStore();
  vi.spyOn(ai, 'explain').mockResolvedValue({
    mode: 'hint', markdown: 'Ein hilfreicher Hinweis',
    hint: { level: 1, markdown: 'Ein hilfreicher Hinweis', nextAction: 'Denke weiter', advisoryOnly: true },
    model: 'test-model', promptVersion: 'v2', source: 'pool', taskVersion: 'hint.v1', cached: true,
  });
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
  return { host: document.body, ai, app, router };
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

  it('lets Escape cancel exit confirmation without leaving the current answer', async () => {
    const { host, router } = await mountPractice();
    const close = host.querySelector<HTMLButtonElement>('[data-practice-exit]')!;
    close.click();
    await settle();
    expect(close.getAttribute('aria-label')).toBe('Programm verlassen bestätigen');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    close.dispatchEvent(escape);
    await settle();
    expect(close.getAttribute('aria-label')).toBe('Programm verlassen');
    expect(escape.defaultPrevented).toBe(true);
    expect(router.currentRoute.value.path).toBe('/practice');
  });

  it('does not carry an armed exit into a new attempt at the same question', async () => {
    const { host } = await mountPractice();
    const close = host.querySelector<HTMLButtonElement>('[data-practice-exit]')!;
    close.click();
    await settle();
    expect(close.classList.contains('practice__close--armed')).toBe(true);
    const practice = usePracticeStore();
    practice.items = [{ ...practice.items[0]!, learningInteractionId: '22222222-2222-4222-8222-222222222222' }];
    await settle();
    expect(close.classList.contains('practice__close--armed')).toBe(false);
    expect(close.getAttribute('aria-label')).toBe('Programm verlassen');
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
    await vi.waitFor(() => expect(host.textContent).toContain('Hinweis 1'));
    expect(host.textContent).not.toContain('KI einrichten');
    ai.status = { ...ready, active: 'none', allowedSources: ['byo'], pool: { eligible: false } };
    await settle();
    expect(host.textContent).toContain('KI einrichten');
    expect(host.querySelector('.q-learning__actions')?.textContent).not.toContain('Nächster Hinweis');
    app.serverInfo = { ...app.serverInfo!, ai: { ...caps, hint: false, explain: false, diagnosis: false } };
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
    expect(router.currentRoute.value.path).toBe('/practice');
  });

  it('hides cached AI help after global disable without leaving an empty correction entry', async () => {
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
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
    expect(host.querySelector('.q-learning')).toBeNull();
    expect(host.textContent).not.toContain('Korrektur');
    expect(host.querySelector('.q-learning__loading, .q-learning__storage, .q-aibadge')).toBeNull();
    player.emit!(state('correct'));
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBeNull();
  });

  it('retains authorized diagnosis as an explanation of the original answer, without a correction action', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canDiagnose).toBe(true));
    const explain = vi.spyOn(ai, 'explain').mockResolvedValue({
      mode: 'diagnosis', markdown: 'Prüfe die Umformung.',
      diagnosis: {
        errorCode: 'algebra', reason: 'Das Vorzeichen stimmt nicht.',
        correctionPrompt: 'Achte auf das Vorzeichen.', advisoryOnly: true,
        evidence: '', evidenceVerified: false, confidence: 0.8,
      },
      model: 'test-model', promptVersion: 'v2', taskVersion: 'diagnosis.v1', source: 'pool', cached: true,
    });
    player.emit!(state('incorrect'));
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')?.textContent).toContain('Lösung erklären');
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('.practice__help-modes button')].find(button => button.textContent === 'Mein Fehler')!.click();
    await settle();
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'diagnosis', submitted: 'x = 3',
      identity: expect.objectContaining({ attemptPhase: 'first', contentId: 'a'.repeat(40) }),
    }), expect.any(AbortSignal), {});
    await vi.waitFor(() => expect(host.textContent).toContain('Das Vorzeichen stimmt nicht.'));
    expect(host.textContent).not.toMatch(/Korrektur|korrigieren/);
    expect([...host.querySelectorAll<HTMLButtonElement>('.practice-bar button')]
      .some((button) => button.textContent?.includes('Weiter'))).toBe(true);
  });

  it('keeps legacy correction cache data intact without replaying it into the normal answer flow', async () => {
    const { host, ai } = await mountPractice(ready, { cached: true, legacyCorrectionCache: true });
    await settle();
    expect(ai.replayExplain).not.toHaveBeenCalled();
    expect(usePracticeStore().items[0]?.cachedAiHint?.attemptPhase).toBe('correction');
    expect(host.textContent).not.toContain('Gespeicherte KI-Antwort');
    expect(host.textContent).not.toMatch(/Korrektur|korrigieren/);
  });

  it('still explains the official solution when the original answer is unavailable, without inventing a diagnosis', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canDiagnose).toBe(true));
    player.emit!({ ...state('incorrect'), submittedText: '' });
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(host.querySelector('.practice__help-modes')).toBeNull();
    expect(ai.explain).toHaveBeenCalledWith(expect.objectContaining({ mode: 'walkthrough', submitted: '' }), expect.any(AbortSignal), {});
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

  it('keeps the question mounted and contains review in the collapsible keyboard-accessible drawer', async () => {
    const { host } = await mountPractice();
    const task = host.querySelector<HTMLElement>('#practice-task-panel')!;
    const mountedPlayer = host.querySelector('.test-player');
    const sheet = host.querySelector<HTMLElement>('.q-ssheet')!;
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.practice-review')).toBeNull();
    player.emit!(state('incorrect'));
    await settle();
    expect(task.style.display).not.toBe('none');
    expect(sheet.getAttribute('aria-hidden')).toBe('false');
    expect(sheet.textContent).not.toContain('Meine Antwort');
    expect(sheet.textContent).not.toContain('x = 3');
    expect(sheet.querySelector('.practice-review__solution')).not.toBeNull();
    expect(task.querySelector('.practice-review')).toBeNull();
    const handle = host.querySelector<HTMLButtonElement>('.q-ssheet__handle')!;
    expect(handle.textContent).toContain('Lösung & Bewertung');
    handle.click();
    await settle();
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
    expect(sheet.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('.test-player')).toBe(mountedPlayer);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    expect(sheet.getAttribute('aria-hidden')).toBe('false');
    expect(sheet.hasAttribute('inert')).toBe(false);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  it('explains an unscored submitted answer without selecting or submitting a grade', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canWalkthrough).toBe(true));
    const practice = usePracticeStore();
    const record = vi.spyOn(practice, 'recordGraded');
    const draft = { version: 1 as const, revision: 1, partId: 'q1-a', savedAt: new Date().toISOString(), submission: { kind: 'open' as const, text: 'Mein Ansatz', selfAssessment: {} }, assessment: {}, selectedPoints: null, grading: null, indeterminate: false, indeterminateMax: 1 };
    vi.spyOn(practice, 'currentSelfAssessmentDraft', 'get').mockReturnValue(draft);
    const explain = vi.mocked(ai.explain).mockResolvedValue({ mode: 'walkthrough', markdown: 'Schritt für Schritt', model: 'test', promptVersion: 'v2', source: 'pool', taskVersion: 'walkthrough.v1', cached: true });
    player.emit!({ ...state(), phase: 'self-assessing', submittedText: 'Mein Ansatz', selfAssessment: { maxPoints: 1, scoreOptions: [{ points: 0, label: '0' }, { points: 1, label: '1' }], selectedPoints: null, grading: null, assessment: {} } });
    await settle();
    expect(host.querySelector('.practice-bar--full')).not.toBeNull();
    expect(host.querySelector('.q-ssheet .q-selfassess')).not.toBeNull();
    expect(host.querySelector('#practice-task-panel .q-selfassess')).toBeNull();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({ mode: 'walkthrough', submitted: 'Mein Ansatz', identity: expect.objectContaining({ taskVersion: 'walkthrough.v1' }) }), expect.any(AbortSignal), {});
    expect(explain.mock.calls[0]![0]).not.toHaveProperty('result');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Schritt für Schritt');
    expect(record).not.toHaveBeenCalled();
    expect(host.querySelector('.q-selfassess [aria-checked="true"]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('.practice-bar--full')).not.toBeNull();
    expect(host.querySelector('.q-ssheet')?.getAttribute('aria-hidden')).toBe('false');
  });

  it('offers a walkthrough after a correct answer and reopens its result without requesting again', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canWalkthrough).toBe(true));
    const explain = vi.mocked(ai.explain).mockResolvedValue({ mode: 'walkthrough', markdown: 'So funktioniert der Lösungsweg.', model: 'test', promptVersion: 'v2', source: 'pool', taskVersion: 'walkthrough.v1', cached: true });
    player.emit!(state('correct'));
    await settle();
    const entry = host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!;
    entry.focus(); entry.click();
    await settle();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('So funktioniert der Lösungsweg.');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(entry);
    entry.click();
    await settle();
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('retains a failed explanation for an explicit retry while allowing the dialog to close', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canWalkthrough).toBe(true));
    const explain = vi.mocked(ai.explain).mockRejectedValueOnce(new Error('Network error')).mockResolvedValue({ mode: 'walkthrough', markdown: 'Jetzt verfügbar.', model: 'test', promptVersion: 'v2', source: 'pool', taskVersion: 'walkthrough.v1', cached: true });
    player.emit!(state('correct'));
    await settle();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(host.querySelector('.q-learning__error')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.practice-help__footer button')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(explain).toHaveBeenCalledTimes(1);
    host.querySelector<HTMLButtonElement>('.q-learning__error button')!.click();
    await settle();
    expect(explain).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Jetzt verfügbar.');
  });


  it('keeps diagnosis reachable when the server only enables feedback on mistakes', async () => {
    const { host, ai, app } = await mountPractice();
    await vi.waitFor(() => expect(ai.canDiagnose).toBe(true));
    app.serverInfo = { ...app.serverInfo!, ai: { ...caps, explain: false } };
    ai.status = { ...ready, features: { ...ready.features, explain: false } };
    await settle();
    expect(ai.canWalkthrough).toBe(false);
    expect(ai.canDiagnose).toBe(true);
    const explain = vi.mocked(ai.explain).mockResolvedValue({
      mode: 'diagnosis', markdown: 'Prüfe die Umformung.',
      diagnosis: { errorCode: 'algebra', reason: 'Das Vorzeichen stimmt nicht.', correctionPrompt: 'Achte auf das Vorzeichen.', advisoryOnly: true, evidence: '', evidenceVerified: false, confidence: 0.8 },
      model: 'test', promptVersion: 'v2', taskVersion: 'diagnosis.v1', source: 'pool', cached: true,
    });
    player.emit!(state('incorrect'));
    await settle();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({ mode: 'diagnosis' }), expect.any(AbortSignal), {});
    await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Das Vorzeichen stimmt nicht.'));
  });


  it('ignores a superseded paid-request error when changing explanation type', async () => {
    const { host, ai, app } = await mountPractice();
    await vi.waitFor(() => expect(ai.canWalkthrough).toBe(true));
    let rejectOld!: (error: Error) => void;
    const explain = vi.mocked(ai.explain)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockRejectedValueOnce(new Error('Network error'));
    player.emit!(state('incorrect'));
    await settle();
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('.practice__help-modes button')].find(button => button.textContent === 'Mein Fehler')!.click();
    await settle();
    rejectOld(Object.assign(new Error('Already completed'), { code: 'AI_REQUEST_ALREADY_COMPLETED', paidRequestGeneration: 4 }));
    await settle();
    expect(explain).toHaveBeenCalledTimes(2);
    expect(host.querySelector('.q-learning__error')?.textContent).toContain('Erneut versuchen');
    expect(host.querySelector('.q-learning__error')?.textContent).not.toContain('Neu anfragen');
    // A capability change must fall back to the remaining explanation mode.
    app.serverInfo = { ...app.serverInfo!, ai: { ...caps, diagnosis: false } };
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).not.toBeNull();
    expect(host.querySelector('.practice__help-modes')).toBeNull();
    expect(host.querySelector('.q-learning__actions')?.textContent).toContain('Erklärung anfordern');
  });

  it.each(['interaction', 'server'] as const)('discards pending help and remounts the same question after a %s change', async (change) => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canHint).toBe(true));
    let resolve!: (value: Awaited<ReturnType<typeof ai.explain>>) => void;
    const explain = vi.mocked(ai.explain).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const previousPlayer = host.querySelector('.test-player');
    host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!.click();
    await settle();
    expect(explain).toHaveBeenCalledTimes(1);
    if (change === 'interaction') {
      usePracticeStore().items = [{ ...usePracticeStore().items[0]!, learningInteractionId: '22222222-2222-4222-8222-222222222222' }];
    } else {
      useAuthStore().session = { ...useAuthStore().session!, serverBaseUrl: 'https://other.test' };
    }
    await settle();
    resolve({ mode: 'hint', markdown: 'Veraltete Antwort', hint: { level: 1, markdown: 'Veraltete Antwort', nextAction: 'Alt', advisoryOnly: true }, model: 'test', promptVersion: 'v2', source: 'pool', taskVersion: 'hint.v1', cached: true });
    await settle();
    expect(explain.mock.calls[0]![1]!.aborted).toBe(true);
    expect(host.querySelector('.test-player')).not.toBe(previousPlayer);
    expect(host.textContent).not.toContain('Veraltete Antwort');
  });

  it('does not save an AI assessment locator after its pending replay outlives self-assessment', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canAssess(question.parts[0]!, question)).toBe(true));
    const practice = usePracticeStore();
    const record = vi.spyOn(practice, 'recordCachedAiAssessment').mockResolvedValue();
    const answer: AiAssessResult = { overall: { points: 1, confidence: 0.9, quote: 'Mein Ansatz', reason: 'Passt.', quoteVerified: true }, source: 'pool', model: 'test', promptVersion: 'v2', taskVersion: 'assess.v1', cached: true, advisoryOnly: true };
    vi.spyOn(ai, 'assess').mockResolvedValue(answer);
    vi.spyOn(ai, 'assessCacheLocator').mockReturnValue({ cacheKey: 'late-assessment', partId: 'q1-a', attemptPhase: 'first' } as ReturnType<typeof ai.assessCacheLocator>);
    let resolve!: (value: AiAssessResult) => void;
    const replay = vi.spyOn(ai, 'replayAssess').mockImplementation(() => new Promise(done => { resolve = done; }));
    vi.spyOn(practice, 'saveSelfAssessmentDraft').mockResolvedValue(true);
    player.emit!({ ...state(), phase: 'self-assessing', submittedText: 'Mein Ansatz', selfAssessment: { maxPoints: 1, scoreOptions: [{ points: 0, label: '0' }, { points: 1, label: '1' }], selectedPoints: 1, grading: 'good', assessment: { awardedPoints: 1 } } });
    player.draft!({ submission: { kind: 'open', text: 'Mein Ansatz', selfAssessment: { awardedPoints: 1 } }, assessment: { awardedPoints: 1 }, selectedPoints: 1, grading: 'good', indeterminate: false, indeterminateMax: 1 });
    await settle();
    const compare = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Mit KI vergleichen'));
    expect(compare).toBeDefined();
    compare!.click();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    player.emit!(state('correct'));
    await settle();
    resolve(answer);
    await settle();
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps AI actions mounted but disabled while an updated score draft is being saved', async () => {
    const { host, ai } = await mountPractice();
    await vi.waitFor(() => expect(ai.canAssess(question.parts[0]!, question)).toBe(true));
    const practice = usePracticeStore();
    const draft: PartPlayerDraft = {
      submission: { kind: 'open', text: 'Mein Ansatz', selfAssessment: { awardedPoints: 1 } },
      assessment: { awardedPoints: 1 }, selectedPoints: 1, grading: 'good',
      indeterminate: false, indeterminateMax: 1,
    };
    vi.spyOn(practice, 'currentSelfAssessmentDraft', 'get').mockReturnValue({
      ...draft, version: 1, revision: 1, partId: 'q1-a', savedAt: new Date().toISOString(),
    });
    let finish!: (saved: boolean) => void;
    vi.spyOn(practice, 'saveSelfAssessmentDraft').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const assess = vi.spyOn(ai, 'assess');
    player.emit!({ ...state(), phase: 'self-assessing', submittedText: 'Mein Ansatz', selfAssessment: {
      maxPoints: 1, scoreOptions: [{ points: 0, label: '0' }, { points: 1, label: '1' }],
      selectedPoints: 1, grading: 'good', assessment: { awardedPoints: 1 },
    } });
    await settle();
    const learning = host.querySelector<HTMLButtonElement>('.practice-bar__learning-toggle')!;
    const compare = host.querySelector<HTMLButtonElement>('.practice-review__assist')!;
    expect(learning.disabled).toBe(false);
    expect(compare.disabled).toBe(false);
    player.draft!(draft);
    await settle();
    expect(host.querySelector('.practice-bar__learning-toggle')).toBe(learning);
    expect(host.querySelector('.practice-review__assist')).toBe(compare);
    expect(learning.disabled).toBe(true);
    expect(compare.disabled).toBe(true);
    learning.click(); compare.click();
    expect(ai.explain).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
    finish(true);
    await settle();
    expect(learning.disabled).toBe(false);
    expect(compare.disabled).toBe(false);
  });

  it('does not publish an old draft failure into a new interaction with the same question', async () => {
    const { host } = await mountPractice();
    const practice = usePracticeStore();
    let resolve!: (saved: boolean) => void;
    vi.spyOn(practice, 'saveSelfAssessmentDraft').mockImplementation(() => new Promise(done => { resolve = done; }));
    player.emit!({ ...state(), phase: 'self-assessing', submittedText: 'Alter Entwurf' });
    player.draft!({ submission: { kind: 'open', text: 'Alter Entwurf', selfAssessment: {} }, assessment: {}, selectedPoints: null, grading: null, indeterminate: false, indeterminateMax: 1 });
    await settle();
    practice.items = [{ ...practice.items[0]!, learningInteractionId: '22222222-2222-4222-8222-222222222222' }];
    await settle();
    player.emit!(state());
    resolve(false);
    await settle();
    expect(host.textContent).not.toContain('Die Selbstbewertung konnte nicht lokal gespeichert werden.');
    expect(host.textContent).not.toContain('Speichern wiederholen');
  });

  it('does not attach a delayed review-close failure to a replacement interaction', async () => {
    const { host } = await mountPractice();
    const practice = usePracticeStore();
    let reject!: (error: Error) => void;
    const close = vi.spyOn(practice, 'completeReviewAndNext').mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    player.emit!(state('correct'));
    await settle();
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Weiter →')!.click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    practice.items = [{ ...practice.items[0]!, learningInteractionId: '22222222-2222-4222-8222-222222222222' }];
    await settle();
    player.emit!(state());
    reject(new Error('Old session failed'));
    await settle();
    expect(host.textContent).not.toContain('Der Programmstand wurde nicht gespeichert.');
    expect(host.textContent).not.toContain('Speichern wiederholen');
  });

});
