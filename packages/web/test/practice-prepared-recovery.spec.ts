import 'fake-indexeddb/auto';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE, questionContentHash, type CoreRuntimePort, type Question } from '@qed2/core-logic';
import { archiveStore, localProfileStore, ports, questionCache, storage } from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { practiceSessionStorageKey, usePracticeStore, type SessionItem } from '../src/stores/practice.js';
import { useProgressStore } from '../src/stores/progress.js';

const COMMIT = 'e'.repeat(40);
const CONTENT_HASH = 'd'.repeat(64);
const originalCoreRuntime = ports.coreRuntime;
const progressStores: ReturnType<typeof useProgressStore>[] = [];

function question(nr: number): Question {
  const id = `q${nr}`;
  return {
    id, schemaVersion: 3, status: 'reviewed', lang: 'de', title: `Auswahl ${nr}`, playable: true,
    source: { suite: 'srdp', year: 2026, term: 'haupttermin', part: 't1', nr, file: `${id}.pdf` },
    parts: (nr === 2 ? ['a', 'b'] : ['a']).map((label) => ({
      id: `${id}-${label}`, label, points: 1, competencies: [{ code: 'AG 1.1' }],
      answer: {
        kind: 'choice', selectCount: 1, correct: [0],
        options: [[{ t: 'text', v: 'richtig' }], [{ t: 'text', v: 'falsch' }]],
      },
      scoring: { mode: 'allOrNothing', points: 1 },
    })),
  };
}

const BANK = [question(1), question(2)];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubCore() {
  const missingQuestions = new Set<string>();
  const missingParts = new Set<string>();
  const failures = new Set<string>();
  const recommends = vi.fn();
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/content/manifest') {
      return json({ commit: COMMIT, items: Object.fromEntries(BANK.map((q) => [q.id, CONTENT_HASH])) });
    }
    if (path === '/content/questions/batch') {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      if (ids.some((id) => failures.has(id))) {
        return json({ error: { code: 'UNAVAILABLE', message: 'Selected batch unavailable' } }, 503);
      }
      const questions = BANK.filter((q) => ids.includes(q.id) && !missingQuestions.has(q.id))
        .map((q) => ({ ...q, parts: q.parts.filter((part) => !missingParts.has(part.id)) }));
      return json({
        questions: questions.map((q) => ({ ...q, contentHash: CONTENT_HASH, wireHash: questionContentHash(q) })),
        missing: ids.filter((id) => missingQuestions.has(id)),
      });
    }
    if (path === '/content/recommend') {
      recommends();
      return json({ items: [{ questionId: 'q1', partId: 'q1-a', reason: 'new' }] });
    }
    return json({ error: { code: 'NOT_FOUND', message: 'No route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { missingQuestions, missingParts, failures, recommends, fetchSpy };
}

async function freshPractice() {
  setActivePinia(createPinia());
  const app = useAppStore();
  app.coreEndpointUrl = 'https://core.prepared-recovery.test';
  app.coreEndpointSource = 'remote';
  const progress = useProgressStore();
  progressStores.push(progress);
  await progress.init();
  return usePracticeStore();
}

function identities(items: SessionItem[]) {
  return items.map(({ questionId, partId, clientAttemptId, learningInteractionId }) => ({
    questionId, partId, clientAttemptId, learningInteractionId,
  }));
}

describe('prepared session cold recovery', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      storage.clear(STORAGE.app), storage.clear(STORAGE.questions), storage.clear(STORAGE.archive),
      storage.clear(STORAGE.history), storage.clear(STORAGE.learning), storage.clear(STORAGE.auth),
    ]);
    await localProfileStore.initialize();
    await archiveStore.save({ content: { perPart: [], perCompetency: [] }, baseVersion: 0 });
    ports.coreRuntime = {
      capabilities: { localCore: false },
      getEndpoint: async (source = 'remote') => ({ baseUrl: 'https://core.prepared-recovery.test', source }),
    } satisfies CoreRuntimePort;
  });

  afterEach(() => {
    for (const progress of progressStores.splice(0)) progress.cancelCloudRecovery();
    ports.coreRuntime = originalCoreRuntime;
    vi.unstubAllGlobals();
  });

  it.each(['missing question', 'missing part', 'partial offline cache'] as const)(
    'fails closed for a %s without rewriting the saved selection',
    async (unavailable) => {
      const core = stubCore();
      const first = await freshPractice();
      const preparedId = await first.startPrepared(['q2', 'q1'], 'remote', COMMIT);
      const key = practiceSessionStorageKey(localProfileStore.current());
      const saved = await storage.get(STORAGE.app, key);
      await storage.clear(STORAGE.questions);

      if (unavailable === 'missing question') core.missingQuestions.add('q2');
      if (unavailable === 'missing part') core.missingParts.add('q2-b');
      if (unavailable === 'partial offline cache') {
        const cached = BANK[0]!;
        await questionCache.putManyVerified([{
          question: cached, contentHash: CONTENT_HASH, wireHash: questionContentHash(cached),
        }], COMMIT);
        core.failures.add('q2');
      }

      const restored = await freshPractice();
      await restored.restoreSession('manual', preparedId);

      expect(restored.phase).toBe('error');
      expect(restored.current).toBeUndefined();
      expect(restored.items).toEqual([]);
      expect(await storage.get(STORAGE.app, key)).toEqual(saved);
      expect(core.recommends).not.toHaveBeenCalled();
    },
  );

  it('retries an immutable failed restore with the original attempt and learning identities', async () => {
    const core = stubCore();
    const first = await freshPractice();
    const preparedId = await first.startPrepared(['q2', 'q1'], 'remote', COMMIT);
    const originalIdentities = identities(first.items);
    await expect(first.saveAnswerDraft('q2-a', { kind: 'choice', selected: [1] }))
      .resolves.toEqual({ status: 'saved' });
    const key = practiceSessionStorageKey(localProfileStore.current());
    const saved = await storage.get(STORAGE.app, key);
    await storage.clear(STORAGE.questions);
    core.failures.add('q2');
    const restored = await freshPractice();
    await restored.restoreSession('manual', preparedId);
    expect(restored.phase).toBe('error');
    expect(await storage.get(STORAGE.app, key)).toEqual(saved);

    core.failures.clear();
    await restored.retry();

    expect(restored.phase).toBe('running');
    expect(restored.sessionIdentityDurable).toBe(true);
    expect(identities(restored.items)).toEqual(originalIdentities);
    expect(restored.items[0]?.clientAttemptId).toBe(preparedId);
    expect(restored.currentAnswerDraft).toEqual({ kind: 'choice', selected: [1] });
    expect(restored.contentSource).toBe('remote');
    expect(restored.contentId).toBe(COMMIT);
    const durable = await storage.get<{ items: SessionItem[] }>(STORAGE.app, key);
    expect(identities(durable!.items)).toEqual(originalIdentities);
    await expect(restored.restoreSession('manual', preparedId)).resolves.toBe(true);
    expect(core.recommends).not.toHaveBeenCalled();
  });

  it('does not adopt a failed legacy provenance choice for an unrelated valid prepared UUID', async () => {
    const core = stubCore();
    const first = await freshPractice();
    await first.startPrepared(['q2', 'q1'], 'remote', COMMIT);
    const key = practiceSessionStorageKey(localProfileStore.current());
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, key);
    const legacy: Record<string, unknown> = { ...saved, version: 3 };
    delete legacy.contentId;
    delete legacy.contentSource;
    await storage.set(STORAGE.app, key, legacy);

    const restored = await freshPractice();
    await expect(restored.restoreSession()).resolves.toBe(true);
    expect(restored.phase).toBe('provenance-choice');
    await storage.clear(STORAGE.questions);
    core.failures.add('q2');
    await restored.resumeWithCurrentContent();
    expect(restored.phase).toBe('error');
    const beforeHandoff = await storage.get(STORAGE.app, key);
    const callsBeforeHandoff = core.fetchSpy.mock.calls.length;

    await expect(restored.restoreSession('manual', '11111111-1111-4111-8111-111111111111'))
      .resolves.toBe(false);

    expect(restored.phase).toBe('error');
    expect(restored.current).toBeUndefined();
    expect(await storage.get(STORAGE.app, key)).toEqual(beforeHandoff);
    expect(core.fetchSpy).toHaveBeenCalledTimes(callsBeforeHandoff);
    expect(core.recommends).not.toHaveBeenCalled();
  });
});
