import 'fake-indexeddb/auto';
import { createApp, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE, questionContentHash, type CoreRuntimePort, type Question, type QuestionSummary } from '@qed2/core-logic';
import BrowseView from '../src/routes/BrowseView.vue';
import PracticeView from '../src/routes/PracticeView.vue';
import { archiveStore, localProfileStore, ports, storage } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { practiceSessionStorageKey, usePracticeStore } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const COMMIT = 'e'.repeat(40);
const RAW_HASH = 'd'.repeat(64);
const originalCoreRuntime = ports.coreRuntime;
let unmount: (() => void) | undefined;

function question(nr: number): Question {
  const id = `q${nr}`;
  return {
    id, schemaVersion: 3, status: 'reviewed', lang: 'de', title: `Auswahl ${nr}`, playable: true,
    source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr, file: `${id}.pdf` },
    parts: [{
      id: `${id}-a`, label: 'a', points: 1, competencies: [{ code: 'AG 1.1' }],
      answer: {
        kind: 'choice', selectCount: 1, correct: [0],
        options: [[{ t: 'text', v: 'richtig' }], [{ t: 'text', v: 'falsch' }]],
      },
      scoring: { mode: 'allOrNothing', points: 1 },
    }],
  };
}

const BANK = [question(1), question(2), question(3)];
const SUMMARIES: QuestionSummary[] = BANK.map((q) => ({
  id: q.id, title: q.title, source: q.source, status: q.status, playable: true, totalPoints: 1,
  parts: q.parts.map((part) => ({
    id: part.id, label: part.label, format: '1 aus 2', competencies: part.competencies, hasFigures: false,
  })),
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubCore() {
  const batches: string[][] = [];
  const recommends = vi.fn();
  const failures = new Set<string>();
  const missing = new Set<string>();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/content/manifest') {
      return json({ commit: COMMIT, items: Object.fromEntries(BANK.map((q) => [q.id, RAW_HASH])) });
    }
    if (path === '/content/questions') return json({ items: SUMMARIES, total: BANK.length, page: 1, pageSize: 200 });
    if (path === '/content/questions/batch') {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      batches.push(ids);
      if (ids.some((id) => failures.has(id))) return json({ error: { code: 'UNAVAILABLE', message: 'Selected batch unavailable' } }, 503);
      return json({
        questions: BANK.filter((q) => ids.includes(q.id) && !missing.has(q.id)).map((q) => ({
          ...q, contentHash: RAW_HASH, wireHash: questionContentHash(q),
        })),
        missing: ids.filter((id) => missing.has(id)),
      });
    }
    if (path === '/content/recommend') {
      recommends();
      return json({ items: [{ questionId: 'q1', partId: 'q1-a', reason: 'new' }] });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'No route' } }, 404);
  }));
  return { batches, recommends, failures, missing };
}

async function createStores() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = useAppStore();
  app.coreEndpointUrl = 'https://core.handoff.test';
  app.coreEndpointSource = 'remote';
  await useProgressStore().init();
  return { pinia, practice: usePracticeStore() };
}

async function mountRoutes(pinia: ReturnType<typeof createPinia>, path = '/questions') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/questions', component: BrowseView },
    { path: '/practice', component: PracticeView },
    { path: '/settings', component: { template: '<div />' } },
  ] });
  await router.push(path);
  const host = document.createElement('div');
  document.body.append(host);
  const view = createApp({ render: () => h(RouterView) }).use(pinia).use(router);
  view.mount(host);
  unmount = () => view.unmount();
  await nextTick();
  return { host, router };
}

function pickRow(host: HTMLElement, title: string): void {
  const row = [...host.querySelectorAll<HTMLButtonElement>('.browse__row')]
    .find((candidate) => candidate.textContent?.includes(title));
  expect(row).toBeDefined();
  row!.click();
}

function startButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.browse__head button')]
    .find((candidate) => candidate.textContent?.includes('Üben'));
  expect(button).toBeDefined();
  return button!;
}

describe('Browse → Practice prepared handoff', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('scrollTo', vi.fn());
    await Promise.all([
      storage.clear(STORAGE.app), storage.clear(STORAGE.archive), storage.clear(STORAGE.auth),
      storage.clear(STORAGE.questions), storage.clear(STORAGE.history),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
    ports.coreRuntime = {
      capabilities: { localCore: false },
      getEndpoint: async (source = 'remote') => ({ baseUrl: 'https://core.handoff.test', source }),
    } satisfies CoreRuntimePort;
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    useProgressStore().cancelCloudRecovery();
    ports.coreRuntime = originalCoreRuntime;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('starts exactly the selected subset in selection order through both real routes', async () => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    const restore = vi.spyOn(practice, 'restoreSession');
    const { host, router } = await mountRoutes(pinia);
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row')).toHaveLength(3));
    pickRow(host, 'Auswahl 3');
    pickRow(host, 'Auswahl 1');
    await nextTick();
    startButton(host).click();

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/practice'));
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    await restore.mock.results[0]!.value;
    await nextTick();
    expect(host.querySelector('.practice__body')).not.toBeNull();
    expect(practice.items.map((item) => item.questionId)).toEqual(['q3', 'q1']);
    expect(practice.current?.question.id).toBe('q3');
    expect(host.querySelector('.practice-qhead__title')?.textContent).toBe('Auswahl 3');
    expect(practice.origin).toBe('manual');
    expect(practice.contentId).toBe(COMMIT);
    expect(practice.contentSource).toBe('remote');
    expect(practice.sessionIdentityDurable).toBe(true);
    expect(router.currentRoute.value.query.prepared).toBe(practice.items[0]?.clientAttemptId);
    expect(core.batches).toEqual([['q3', 'q1']]);
    expect(core.recommends).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps a failed selection on Browse instead of restoring old or recommended questions (old session: %s)', async (oldSession) => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    if (oldSession) await practice.startQuestions(['q1'], 'remote', COMMIT);
    core.failures.add('q2');
    const { host, router } = await mountRoutes(pinia);
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row')).toHaveLength(3));
    pickRow(host, 'Auswahl 2');
    await nextTick();
    startButton(host).click();

    await vi.waitFor(() => expect(practice.phase).toBe('error'));
    await vi.waitFor(() => expect(startButton(host).disabled).toBe(false));
    expect(router.currentRoute.value.path).toBe('/questions');
    expect(host.textContent).toMatch(/erneut versuchen|unavailable/i);
    expect(core.batches.at(-1)).toEqual(['q2']);
    expect(core.recommends).not.toHaveBeenCalled();
  });

  it.each(['not-a-token', '11111111-1111-4111-8111-111111111111'])('does not replace an existing manual session for an invalid or mismatched token: %s', async (token) => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    await practice.startQuestions(['q1'], 'remote', COMMIT);
    const firstId = practice.items[0]?.clientAttemptId;
    const startSmart = vi.spyOn(practice, 'startSmart');
    const { host } = await mountRoutes(pinia, `/practice?prepared=${token}`);

    await vi.waitFor(() => expect(host.querySelector('.practice__body')).toBeNull());
    await vi.waitFor(() => expect(host.textContent).toMatch(/Auswahl|erneut|zurück/i));
    await nextTick();
    expect(startSmart).not.toHaveBeenCalled();
    expect(core.recommends).not.toHaveBeenCalled();
    expect(practice.items.map((item) => item.questionId)).toEqual(['q1']);
    expect(practice.items[0]?.clientAttemptId).toBe(firstId);
    expect(host.querySelector('.practice__body')).toBeNull();
  });

  it('does not start a partial selection or overwrite the prior saved programme', async () => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    await practice.startQuestions(['q1'], 'remote', COMMIT);
    const key = practiceSessionStorageKey(localProfileStore.current());
    const saved = await storage.get(STORAGE.app, key);
    core.missing.add('q3');
    const { host, router } = await mountRoutes(pinia);
    await vi.waitFor(() => expect(host.querySelectorAll('.browse__row')).toHaveLength(3));
    pickRow(host, 'Auswahl 2');
    pickRow(host, 'Auswahl 3');
    await nextTick();
    startButton(host).click();

    await vi.waitFor(() => expect(practice.phase).toBe('error'));
    await vi.waitFor(() => expect(startButton(host).disabled).toBe(false));
    expect(router.currentRoute.value.path).toBe('/questions');
    const selected = [...host.querySelectorAll('.browse__row .browse__select[aria-pressed="true"]')];
    expect(selected).toHaveLength(2);
    expect(selected.map((button) => button.closest('.browse__row')?.querySelector('.browse__qtitle')?.textContent?.trim()))
      .toEqual(['Auswahl 2', 'Auswahl 3']);
    expect(core.batches.at(-1)).toEqual(['q2', 'q3']);
    expect(core.recommends).not.toHaveBeenCalled();
    expect(await storage.get(STORAGE.app, key)).toEqual(saved);
  });

  it('a mismatched persisted handoff is not treated as a generic resume request', async () => {
    const core = stubCore();
    const first = await createStores();
    await first.practice.startQuestions(['q1'], 'remote', COMMIT);
    const key = practiceSessionStorageKey(localProfileStore.current());
    const saved = await storage.get(STORAGE.app, key);
    const { pinia, practice } = await createStores();
    const startSmart = vi.spyOn(practice, 'startSmart');
    const { host } = await mountRoutes(pinia, '/practice?prepared=11111111-1111-4111-8111-111111111111');

    await vi.waitFor(() => expect(host.textContent).toMatch(/erneut|zurück/i));
    expect(host.querySelector('.practice__body')).toBeNull();
    expect(practice.items).toEqual([]);
    expect(core.batches).toEqual([['q1']]);
    expect(startSmart).not.toHaveBeenCalled();
    expect(core.recommends).not.toHaveBeenCalled();
    expect(await storage.get(STORAGE.app, key)).toEqual(saved);
  });

  it('revalidates a query-only handoff change without exposing or replacing the live selection', async () => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    const token = await practice.startPrepared(['q3', 'q2'], 'remote', COMMIT);
    const startSmart = vi.spyOn(practice, 'startSmart');
    const { host, router } = await mountRoutes(pinia, `/practice?prepared=${token}`);
    await vi.waitFor(() => expect(host.querySelector('.practice-qhead__title')?.textContent).toBe('Auswahl 3'));

    await router.push('/practice?prepared=not-a-token');
    await vi.waitFor(() => expect(host.querySelector('.practice__body')).toBeNull());
    await vi.waitFor(() => expect(host.textContent).toMatch(/erneut|zurück/i));
    expect(practice.items.map((item) => item.questionId)).toEqual(['q3', 'q2']);
    expect(startSmart).not.toHaveBeenCalled();
    expect(core.recommends).not.toHaveBeenCalled();

    await router.push(`/practice?prepared=${token}`);
    await vi.waitFor(() => expect(host.querySelector('.practice-qhead__title')?.textContent).toBe('Auswahl 3'));
    expect(practice.items.map((item) => item.questionId)).toEqual(['q3', 'q2']);
    expect(practice.items[0]?.clientAttemptId).toBe(token);
    expect(practice.origin).toBe('manual');
    expect(core.batches).toEqual([['q3', 'q2']]);
    expect(startSmart).not.toHaveBeenCalled();
    expect(core.recommends).not.toHaveBeenCalled();
  });

  it('treats query-only navigation to plain practice as an explicit smart-programme intent', async () => {
    const core = stubCore();
    const { pinia, practice } = await createStores();
    const token = await practice.startPrepared(['q3', 'q2'], 'remote', COMMIT);
    const { host, router } = await mountRoutes(pinia, `/practice?prepared=${token}`);
    await vi.waitFor(() => expect(host.querySelector('.practice-qhead__title')?.textContent).toBe('Auswahl 3'));

    await router.push('/practice');

    await vi.waitFor(() => expect(practice.origin).toBe('smart'));
    await vi.waitFor(() => expect(host.querySelector('.practice-qhead__title')?.textContent).toBe('Auswahl 1'));
    expect(practice.items.map((item) => item.questionId)).toEqual(['q1']);
    expect(core.recommends).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.query.prepared).toBeUndefined();
  });
});
