import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  GUEST_ATTEMPT_OWNER,
  STORAGE,
  questionContentHash,
  type AtomicStoragePort,
  type LocalArchive,
  type Question,
  type CoreRuntimePort,
  type ShellPort,
} from '@qed2/core-logic';
import {
  archiveStore,
  attemptOutbox,
  historyLog,
  questionCache,
  storage,
  ports,
} from '../src/services.js';
import { useAppStore } from '../src/stores/app.js';
import { usePracticeStore, type SessionItem } from '../src/stores/practice.js';
import { useAuthStore } from '../src/stores/auth.js';
import { useProgressStore } from '../src/stores/progress.js';

const EMPTY_ARCHIVE: LocalArchive = {
  content: { perPart: [], perCompetency: [] },
  baseVersion: 0,
};
const originalCoreRuntime = ports.coreRuntime;
const originalShell = ports.shell;
const TEST_COMMIT = 'c'.repeat(40);
const atomicStorage = storage as typeof storage & AtomicStoragePort;

afterEach(() => {
  ports.coreRuntime = originalCoreRuntime;
  ports.shell = originalShell;
});

function desktopShell(windowKind: 'main' | 'practice'): ShellPort {
  return {
    capabilities: { desktop: true, nativeMenu: true, nativeTitleBar: true },
    windowKind,
    onCommand: () => () => undefined,
  };
}

function question(id: string, nr: number): Question {
  return {
    id,
    schemaVersion: 3,
    status: 'reviewed',
    lang: 'de',
    source: {
      suite: 'srdp',
      year: 2026,
      term: 'haupttermin',
      part: 't1',
      nr,
      file: `${id}.pdf`,
    },
    title: id,
    playable: true,
    parts: [
      {
        id: `${id}-a`,
        label: 'a',
        competencies: [{ code: 'AG 1.1' }],
        answer: {
          kind: 'choice',
          options: [
            [{ t: 'text', v: 'richtig' }],
            [{ t: 'text', v: 'falsch' }],
          ],
          correct: [0],
          selectCount: 1,
        },
        scoring: { mode: 'allOrNothing', points: 1 },
        points: 1,
      },
    ],
  };
}

function contentQuestion(q: Question, contentHash = 'd'.repeat(64)) {
  return { ...q, contentHash, wireHash: questionContentHash(q) };
}

function stubObjectUrls(value = 'blob:test'): {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  const NativeUrl = URL;
  const createObjectURL = vi.fn(() => value);
  const revokeObjectURL = vi.fn();
  class AssetTestUrl extends NativeUrl {}
  Object.defineProperties(AssetTestUrl, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal('URL', AssetTestUrl);
  return { createObjectURL, revokeObjectURL };
}

async function seedImmutableOfflineQuestions(list: Question[]): Promise<void> {
  ports.coreRuntime = {
    capabilities: { localCore: true },
    getEndpoint: async () => ({
      baseUrl: 'http://core.offline.test',
      source: 'local',
      contentId: TEST_COMMIT,
    }),
  } satisfies CoreRuntimePort;
  await questionCache.putManyVerified(
    list.map((q) => ({
      question: q,
      contentHash: 'd'.repeat(64),
      wireHash: questionContentHash(q),
    })),
    TEST_COMMIT,
  );
}

async function freshStores(): Promise<{
  practice: ReturnType<typeof usePracticeStore>;
  progress: ReturnType<typeof useProgressStore>;
}> {
  setActivePinia(createPinia());
  const progress = useProgressStore();
  await progress.init();
  return { practice: usePracticeStore(), progress };
}

async function gradeCurrent(practice: ReturnType<typeof usePracticeStore>): Promise<void> {
  const current = practice.current;
  if (!current) throw new Error('Expected an active practice part');
  await practice.recordGraded({
    part: current.part,
    submission: { kind: 'choice', selected: [0] },
    result: {
      verdict: 'correct',
      correct: true,
      awardedPoints: 1,
      maxPoints: 1,
    },
  });
}

async function guestSession(): Promise<{
  owner?: { userId: string; guestGeneration?: string };
  index?: number;
  graded: Array<{ clientAttemptId: string }>;
} | undefined> {
  return storage.get(STORAGE.app, 'practice-session:guest');
}

describe('practice session persistence', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
      storage.clear(STORAGE.history),
      storage.clear(STORAGE.auth),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([question('q1', 1), question('q2', 2)]);
  });

  it('resumes after the last completed part without losing the daily grade', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const current = first.practice.current;
    expect(current?.part.id).toBe('q1-a');

    await first.practice.recordGraded({
      part: current!.part,
      submission: { kind: 'choice', selected: [0] },
      result: {
        verdict: 'correct',
        correct: true,
        awardedPoints: 1,
        maxPoints: 1,
      },
    });
    first.practice.next();
    await first.practice.finishSession();

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);

    expect(restored.practice.phase).toBe('running');
    expect(restored.practice.graded.map((record) => record.partId)).toEqual(['q1-a']);
    expect(restored.practice.current?.part.id).toBe('q2-a');
    expect(restored.progress.practicedParts).toBe(1);
  });

  it('advances an in-memory paused session when the scored part was not continued', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const current = practice.current;
    await practice.recordGraded({
      part: current!.part,
      submission: { kind: 'choice', selected: [0] },
      result: {
        verdict: 'correct',
        correct: true,
        awardedPoints: 1,
        maxPoints: 1,
      },
    });
    await practice.finishSession();

    await expect(practice.restoreSession()).resolves.toBe(true);
    expect(practice.graded.map((record) => record.partId)).toEqual(['q1-a']);
    expect(practice.current?.part.id).toBe('q2-a');
  });

  it('removes the durable snapshot only when a session is deliberately aborted', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    first.practice.abort();

    await vi.waitFor(async () => {
      expect(await storage.get(STORAGE.app, 'practice-session:guest')).toBeUndefined();
    });
    const restored = await freshStores();

    await expect(restored.practice.restoreSession()).resolves.toBe(false);
    expect(restored.practice.phase).toBe('idle');
  });

  it.each([
    { label: 'v2', version: 2, dropOwner: true, dropSource: true },
    { label: 'v3', version: 3, dropOwner: false, dropSource: true },
    { label: 'incomplete v4', version: 4, dropOwner: false, dropSource: false },
  ])('keeps a $label snapshot untouched and contacts no Core before explicit consent', async ({
    version,
    dropOwner,
    dropSource,
  }) => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, 'practice-session:guest');
    expect(saved).toBeDefined();
    const legacy: Record<string, unknown> = { ...(saved ?? {}), version };
    delete legacy.contentId;
    if (dropOwner) delete legacy.owner;
    if (dropSource) delete legacy.contentSource;
    await storage.set(STORAGE.app, 'practice-session:guest', legacy);

    const getEndpoint = vi.fn(async () => ({
      baseUrl: 'http://core.must-not-be-contacted.test',
      source: 'local' as const,
      contentId: TEST_COMMIT,
    }));
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint,
    } satisfies CoreRuntimePort;
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('must not fetch')));
    vi.stubGlobal('fetch', fetchSpy);

    const restored = await freshStores();
    await expect(restored.practice.restoreSession()).resolves.toBe(true);

    expect(restored.practice.phase).toBe('provenance-choice');
    expect(getEndpoint).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toEqual(legacy);
  });

  it('upgrades an unprovenanced snapshot only after choosing the current bank', async () => {
    const first = await freshStores();
    await first.practice.startQuestions(['q1', 'q2']);
    const saved = await storage.get<Record<string, unknown>>(STORAGE.app, 'practice-session:guest');
    expect(saved).toBeDefined();
    const legacy: Record<string, unknown> = { ...(saved ?? {}), version: 3 };
    delete legacy.contentSource;
    delete legacy.contentId;
    await storage.set(STORAGE.app, 'practice-session:guest', legacy);

    const getEndpoint = vi.fn(async () => ({
      baseUrl: 'http://core.current-choice.test',
      source: 'local' as const,
      contentId: TEST_COMMIT,
    }));
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint,
    } satisfies CoreRuntimePort;
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('offline')));
    vi.stubGlobal('fetch', fetchSpy);

    const restored = await freshStores();
    useAppStore().coreEndpointSource = 'local';
    await restored.practice.restoreSession();
    expect(restored.practice.phase).toBe('provenance-choice');

    await restored.practice.resumeWithCurrentContent();

    expect(restored.practice.phase).toBe('running');
    expect(restored.practice.items.map((item) => item.questionId)).toEqual(['q1', 'q2']);
    expect(getEndpoint).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toMatchObject({
      version: 4,
      contentSource: 'local',
      contentId: TEST_COMMIT,
    });
  });

  it('exposes none of outbox, archive, history, session or memory when the atomic batch fails', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(atomicStorage, 'commitBatch').mockRejectedValueOnce(new Error('simulated disk failure'));

    await expect(gradeCurrent(practice)).rejects.toThrow('simulated disk failure');

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect((await archiveStore.load()).content.perPart).toHaveLength(0);
    expect(await historyLog.count()).toBe(0);
    expect((await guestSession())?.graded).toEqual([]);
    expect(practice.graded).toEqual([]);
  });

  it('retries a CAS conflict and then publishes all four durable records once', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    const commitSpy = vi.spyOn(atomicStorage, 'commitBatch')
      .mockResolvedValueOnce({ committed: false })
      .mockImplementation(commit);

    await expect(gradeCurrent(practice)).resolves.toBeUndefined();

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toMatchObject({ questionId: 'q1', partId: 'q1-a', correct: true });
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toEqual([
      expect.objectContaining({ clientAttemptId: attempt!.clientAttemptId }),
    ]);
    expect(practice.graded).toHaveLength(1);
    expect(commitSpy).toHaveBeenCalledTimes(2);
  });

  it('merges concurrent grades from two tabs into the same durable session', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();
    second.jumpTo(1);
    await vi.waitFor(async () => {
      expect(await guestSession()).toMatchObject({ index: 1 });
    });

    setActivePinia(firstPinia);
    const firstGrade = gradeCurrent(first);
    setActivePinia(secondPinia);
    const secondGrade = gradeCurrent(second);
    await Promise.all([firstGrade, secondGrade]);

    const session = await guestSession();
    expect(new Set(session?.graded.map((record) => record.clientAttemptId)).size).toBe(2);
    expect(new Set(
      (await historyLog.list()).map((entry) => entry.clientAttemptId),
    ).size).toBe(2);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(2);
    expect((await archiveStore.load()).content.perPart.map((part) => part.partId).sort()).toEqual([
      'q1-a',
      'q2-a',
    ]);
  });

  it('does not let a stale cross-tab position save erase a committed grade', async () => {
    const firstPinia = createPinia();
    setActivePinia(firstPinia);
    const firstProgress = useProgressStore();
    await firstProgress.init();
    const first = usePracticeStore();
    await first.startQuestions(['q1', 'q2']);

    const secondPinia = createPinia();
    setActivePinia(secondPinia);
    const secondProgress = useProgressStore();
    await secondProgress.init();
    const second = usePracticeStore();
    await second.restoreSession();

    const originalCommit = atomicStorage.commitBatch.bind(atomicStorage);
    let releasePosition!: () => void;
    const positionGate = new Promise<void>((resolve) => { releasePosition = resolve; });
    let positionEntered!: () => void;
    const entered = new Promise<void>((resolve) => { positionEntered = resolve; });
    let delayed = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      const sessionMutation = request.mutations.find(
        (mutation) => mutation.collection === STORAGE.app
          && mutation.key === 'practice-session:guest',
      );
      const position = sessionMutation?.operation === 'set'
        && typeof sessionMutation.value === 'object'
        && sessionMutation.value !== null
        ? (sessionMutation.value as { index?: unknown }).index
        : undefined;
      if (!delayed && request.mutations.length === 1 && position === 1) {
        delayed = true;
        positionEntered();
        await positionGate;
      }
      return originalCommit(request);
    });

    setActivePinia(secondPinia);
    second.jumpTo(1);
    await entered;
    setActivePinia(firstPinia);
    await gradeCurrent(first);
    releasePosition();

    await vi.waitFor(async () => {
      expect(await guestSession()).toMatchObject({
        index: 1,
        graded: [expect.objectContaining({ clientAttemptId: expect.any(String) })],
      });
    });
    expect(await historyLog.count()).toBe(1);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
  });

  it('reloads durable markers when COMMIT succeeds but its IPC response is lost', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementationOnce(async (request) => {
      await commit(request);
      throw new Error('simulated IPC response loss');
    });

    await expect(gradeCurrent(practice)).resolves.toBeUndefined();

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toHaveLength(1);
    expect(practice.graded).toHaveLength(1);
  });

  it('keeps one idempotent, claimable attempt after the session commits but before flushing', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    vi.spyOn(progress, 'flushStagedAttempt').mockRejectedValueOnce(new Error('crash after session'));

    // Network upload is deliberately background work: the durable local
    // commit must not hold the answer UI hostage to a dead server.
    await expect(gradeCurrent(practice)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(progress.flushStagedAttempt).toHaveBeenCalledTimes(1));

    const [attempt] = await attemptOutbox.list(GUEST_ATTEMPT_OWNER);
    expect(attempt).toMatchObject({
      contentSource: 'local',
      contentId: TEST_COMMIT,
    });
    expect((await archiveStore.load()).content.perPart).toHaveLength(1);
    expect(await historyLog.count()).toBe(1);
    expect((await guestSession())?.graded).toEqual([
      expect.objectContaining({ clientAttemptId: attempt!.clientAttemptId }),
    ]);

    await progress.stageAttempt(attempt!, GUEST_ATTEMPT_OWNER);
    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(1);
    await expect(progress.claimGuestAttempts('recovered-user')).resolves.toBe(1);
    expect(await attemptOutbox.list('recovered-user')).toEqual([attempt]);
  });

  it('retries against a concurrent guest claim and keeps its session key fixed', async () => {
    const { practice, progress } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    const commit = atomicStorage.commitBatch.bind(atomicStorage);
    let raced = false;
    vi.spyOn(atomicStorage, 'commitBatch').mockImplementation(async (request) => {
      if (!raced) {
        raced = true;
        await expect(progress.claimGuestAttempts('claimed-user')).resolves.toBe(0);
        useAuthStore().session = {
          token: 'claimed-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          user: { id: 'claimed-user', username: 'claimed' },
        };
      }
      return commit(request);
    });

    await gradeCurrent(practice);

    expect(await attemptOutbox.count(GUEST_ATTEMPT_OWNER)).toBe(0);
    expect(await attemptOutbox.count('claimed-user')).toBe(1);
    expect((await guestSession())?.owner).toMatchObject({ userId: GUEST_ATTEMPT_OWNER });
    expect((await guestSession())?.graded).toHaveLength(1);
    await expect(
      storage.get(STORAGE.app, 'practice-session:claimed-user'),
    ).resolves.toBeUndefined();
  });
});

/**
 * „Programm üben" in the navigation means today's FSRS programme. A set the
 * user hand-picked in the Aufgaben list is a different thing that happens to
 * run on the same screen — resuming it there is the bug this guards.
 */
describe('session origin', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([question('q1', 1), question('q2', 2)]);
  });

  it('tags a hand-picked set as manual and a recommendation as smart', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);
    expect(practice.origin).toBe('manual');
  });

  it('refuses to hand a left-over manual set back to the programme entry', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession(); // leaving the screen persists, never aborts

    // In memory (same tab, user tapped the nav entry right after leaving).
    await expect(practice.restoreSession('smart')).resolves.toBe(false);

    // And after a reload, from the durable snapshot.
    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(false);
    expect(reloaded.practice.phase).toBe('idle');
  });

  it('does not hand back a programme saved on an earlier day', async () => {
    // „Programm starten" means TODAY's due reviews. Without a bound the same
    // half-finished list came back forever and FSRS never ran again.
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const stale = await storage.get<Record<string, unknown>>(
      STORAGE.app,
      'practice-session:guest',
    );
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await storage.set(STORAGE.app, 'practice-session:guest', {
      ...stale,
      origin: 'smart',
      savedAt: yesterday,
    });

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(false);
    expect(reloaded.practice.phase).toBe('idle');
    // …and the stale snapshot is cleared rather than left to be re-offered.
    await expect(
      storage.get(STORAGE.app, 'practice-session:guest'),
    ).resolves.toBeUndefined();
  });

  it('still resumes a programme saved earlier the same day', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const saved = await storage.get<Record<string, unknown>>(
      STORAGE.app,
      'practice-session:guest',
    );
    await storage.set(STORAGE.app, 'practice-session:guest', {
      ...saved,
      origin: 'smart',
      savedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession('smart')).resolves.toBe(true);
    expect(reloaded.practice.phase).toBe('running');
  });

  it('retries the request the user actually made, not whatever the URL says', async () => {
    // The Aufgaben bulk handoff puts no ids in the URL, so a retry that
    // re-read the route silently swapped the hand-picked set for the FSRS
    // programme.
    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);
    expect(practice.origin).toBe('manual');

    await practice.retry();
    expect(practice.origin).toBe('manual');
    expect(practice.items.map((i) => i.questionId)).toEqual(['q1']);
  });

  it('pins the active Core source at the start action even if another window changes it', async () => {
    const { practice, progress } = await freshStores();
    const app = useAppStore();
    app.coreEndpointSource = 'local';
    const getEndpoint = vi.fn(async (source: 'local' | 'remote' = 'remote') => ({
      baseUrl: source === 'local' ? 'http://127.0.0.1:1122/__qed2_core/local' : 'https://core.example',
      source,
      ...(source === 'local' ? { contentId: TEST_COMMIT } : {}),
    }));
    ports.coreRuntime = {
      capabilities: { localCore: false },
      getEndpoint,
    } satisfies CoreRuntimePort;

    let captureEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      captureEntered = resolve;
    });
    let releaseCapture!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const originalCapture = progress.captureAttemptOwner.bind(progress);
    vi.spyOn(progress, 'captureAttemptOwner').mockImplementationOnce(async () => {
      captureEntered();
      await gate;
      return originalCapture();
    });

    const starting = practice.startQuestions(['q1']);
    await entered;
    app.coreEndpointSource = 'remote';
    releaseCapture();
    await starting;

    expect(getEndpoint).toHaveBeenCalledWith('local');
    expect(practice.contentSource).toBe('local');
    expect(practice.phase).toBe('running');
  });

  it('still resumes that set for the Aufgaben handoff and for an unrestricted call', async () => {
    const { practice } = await freshStores();
    await practice.startQuestions(['q1', 'q2']);
    await practice.finishSession();

    const reloaded = await freshStores();
    await expect(reloaded.practice.restoreSession()).resolves.toBe(true);
    expect(reloaded.practice.origin).toBe('manual');
    expect(reloaded.practice.current?.part.id).toBe('q1-a');
  });
});

describe('practice content revision integrity', () => {
  const commitA = 'a'.repeat(40);
  const commitB = 'b'.repeat(40);

  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async (source = 'remote') => ({
        baseUrl: 'http://core.integrity.test',
        source,
      }),
    } satisfies CoreRuntimePort;
  });

  function reply(body: unknown): object {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    };
  }

  async function verifiedPng(contents: string): Promise<Response> {
    const bytes = new TextEncoder().encode(contents);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'image/png',
        etag: `"${hash}"`,
      },
    });
  }

  it('admits a batch only after its hashes and post-download revision agree', async () => {
    const q1 = question('q1', 1);
    const rawHash = '1'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: commitA, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);
    await expect(questionCache.get('q1', commitA)).resolves.toEqual(q1);
  });

  it('rejects and never caches a question whose manifest hash does not match', async () => {
    const expected = question('q1', 1);
    const tampered = { ...expected, title: 'manipuliert' };
    const rawHash = '2'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: commitA, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({
          questions: [{ ...tampered, contentHash: rawHash, wireHash: questionContentHash(expected) }],
          missing: [],
        });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('Übertragungs-Prüfsumme');
    expect(practice.questions.size).toBe(0);
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
    await expect(questionCache.get('q1')).resolves.toBeUndefined();
  });

  it('fails closed when the deployment changes between manifest and batch', async () => {
    const q1 = question('q1', 1);
    const rawHash = '3'.repeat(64);
    let manifestCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        manifestCalls += 1;
        const commit = manifestCalls === 1 ? commitA : commitB;
        return reply({ commit, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('während des Ladens aktualisiert');
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
  });

  it('never admits a successful batch or legacy cache after the manifest request fails', async () => {
    const old = { ...question('q1', 1), title: 'legacy' };
    const fresh = { ...question('q1', 1), title: 'network' };
    const batchCalls = vi.fn();
    await questionCache.put(old);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async () => ({
        baseUrl: 'http://core.integrity.test',
        source: 'remote',
        contentId: commitA,
      }),
    } satisfies CoreRuntimePort;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) throw new TypeError('offline');
      if (path.endsWith('/content/questions/batch')) {
        batchCalls();
        return reply({ questions: [contentQuestion(fresh)], missing: [] });
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1']);

    expect(practice.phase).toBe('error');
    expect(practice.questions.size).toBe(0);
    expect(batchCalls).not.toHaveBeenCalled();
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
    await expect(questionCache.get('q1')).resolves.toEqual(old);
  });

  it('uses an atomic revision/raw-hash/wire-hash cache envelope on a later offline local start', async () => {
    const q1 = question('q1', 1);
    const rawHash = '4'.repeat(64);
    await questionCache.putManyVerified([
      { question: q1, contentHash: rawHash, wireHash: questionContentHash(q1) },
    ], commitA);
    ports.coreRuntime = {
      capabilities: { localCore: true },
      getEndpoint: async () => ({
        baseUrl: 'http://core.integrity.test',
        source: 'local',
        contentId: commitA,
      }),
    } satisfies CoreRuntimePort;
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'local', commitA);

    expect(practice.phase).toBe('running');
    expect(practice.current?.question).toEqual(q1);
  });

  it('pins remote figures to blobs before confirming the same deployment', async () => {
    const q1: Question = {
      ...question('q1', 1),
      prompt: [{ t: 'fig', src: 'assets/fig/q1.png', alt: 'q1' }],
    };
    const rawHash = '5'.repeat(64);
    let deployment = commitA;
    const assetFetches: string[] = [];
    stubObjectUrls('blob:q1-commit-a');
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/q1.png`) {
        assetFetches.push(deployment);
        return verifiedPng(`image-${deployment}`);
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    deployment = commitB;

    expect(practice.phase).toBe('running');
    expect(assetFetches).toEqual([commitA]);
    expect(practice.assetUrl('assets/fig/q1.png')).toBe('blob:q1-commit-a');
  });

  it('rejects an asset snapshot when the deployment switches during its download', async () => {
    const q1: Question = {
      ...question('q1', 1),
      prompt: [{ t: 'fig', src: 'assets/fig/q1.png' }],
    };
    const rawHash = '6'.repeat(64);
    let deployment = commitA;
    const { createObjectURL } = stubObjectUrls();
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/q1.png`) {
        deployment = commitB;
        return verifiedPng('new-deployment-image');
      }
      return reply({});
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('während des Ladens aktualisiert');
    expect(createObjectURL).not.toHaveBeenCalled();
    await expect(questionCache.get('q1', commitA)).resolves.toBeUndefined();
  });

  it('restores an old question and figure through the immutable revision API', async () => {
    const oldQuestion: Question = {
      ...question('q1', 1),
      title: 'Historische Aufgabe',
      prompt: [{ t: 'fig', src: 'assets/fig/old.png', alt: 'historisch' }],
    };
    const oldRawHash = '9'.repeat(64);
    const liveBatch = vi.fn();
    const { createObjectURL } = stubObjectUrls('blob:historical-asset');
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path === '/content/manifest') {
        return reply({ commit: commitB, items: { q1: '8'.repeat(64) } });
      }
      if (path === `/content/revisions/${commitA}/manifest`) {
        return reply({ commit: commitA, items: { q1: oldRawHash } });
      }
      if (path === `/content/revisions/${commitA}/questions/batch`) {
        return reply({ questions: [contentQuestion(oldQuestion, oldRawHash)], missing: [] });
      }
      if (path === `/content/revisions/${commitA}/assets/fig/old.png`) {
        return verifiedPng('old-image');
      }
      if (path === '/content/questions/batch') liveBatch();
      throw new Error(`unexpected request ${path}`);
    }));

    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote', commitA);

    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);
    expect(practice.contentMode).toBe('revision');
    expect(practice.current?.question.title).toBe('Historische Aufgabe');
    expect(practice.assetUrl('assets/fig/old.png')).toBe('blob:historical-asset');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(liveBatch).not.toHaveBeenCalled();
    await expect(questionCache.getVerified('q1', commitA, oldRawHash)).resolves.toEqual(oldQuestion);
    await expect(questionCache.get('q1')).resolves.toBeUndefined();
  });

  it('does not resume a revision-pinned remote bank when that revision cannot be confirmed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    setActivePinia(createPinia());
    const app = useAppStore();

    await expect(app.pinCoreContent('remote', commitA)).rejects.toThrow(
      'ursprüngliche Version dieser Aufgaben ist nicht verfügbar',
    );
  });

  it('moves an already-running remote session to a fail-closed error when restore goes offline', async () => {
    const q1 = question('q1', 1);
    const rawHash = '7'.repeat(64);
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) return reply({ commit: commitA, items: { q1: rawHash } });
      if (path.endsWith('/content/questions/batch')) {
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));
    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    expect(practice.phase).toBe('running');

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await expect(practice.restoreSession()).resolves.toBe(true);

    expect(practice.phase).toBe('error');
    expect(practice.questions.size).toBe(0);
    expect(practice.error).toContain('ursprüngliche Version dieser Aufgaben');
  });

  it('backfills the first confirmed commit so retry cannot drift to a newer deployment', async () => {
    const q1 = question('q1', 1);
    const rawHash = '8'.repeat(64);
    let deployment = commitA;
    let batchCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (rawUrl: string) => {
      const path = new URL(rawUrl).pathname;
      if (path.endsWith('/content/manifest')) {
        return reply({ commit: deployment, items: { q1: rawHash } });
      }
      if (path.endsWith('/content/questions/batch')) {
        batchCalls += 1;
        return reply({ questions: [contentQuestion(q1, rawHash)], missing: [] });
      }
      return reply({});
    }));
    const { practice } = await freshStores();
    await practice.startQuestions(['q1'], 'remote');
    expect(practice.phase).toBe('running');
    expect(practice.contentId).toBe(commitA);

    deployment = commitB;
    await practice.retry();

    expect(practice.phase).toBe('error');
    expect(practice.error).toContain('ursprüngliche Version dieser Aufgaben');
    expect(batchCalls).toBe(1);
  });
});

describe('desktop practice window isolation', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    await Promise.all([
      storage.clear(STORAGE.app),
      storage.clear(STORAGE.questions),
      storage.clear(STORAGE.archive),
    ]);
    await archiveStore.save(EMPTY_ARCHIVE);
    await seedImmutableOfflineQuestions([question('q1', 1), question('q2', 2)]);
  });

  it('keeps main and native-practice snapshots in independent durable keys', async () => {
    ports.shell = desktopShell('main');
    const main = await freshStores();
    await main.practice.startQuestions(['q1', 'q2']);

    ports.shell = desktopShell('practice');
    const native = await freshStores();
    await native.practice.startQuestions(['q2']);

    expect(await storage.get<{ items: SessionItem[] }>(STORAGE.app, 'practice-session:guest:main'))
      .toMatchObject({ items: [expect.objectContaining({ questionId: 'q1' }), expect.objectContaining({ questionId: 'q2' })] });
    expect(await storage.get<{ items: SessionItem[] }>(STORAGE.app, 'practice-session:guest:practice'))
      .toMatchObject({ items: [expect.objectContaining({ questionId: 'q2' })] });
    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toBeUndefined();
  });

  it('atomically migrates a pre-upgrade snapshot into the first Desktop window', async () => {
    ports.shell = originalShell;
    const oldWebSession = await freshStores();
    await oldWebSession.practice.startQuestions(['q1', 'q2']);
    expect(await storage.get(STORAGE.app, 'practice-session:guest')).toBeDefined();

    ports.shell = desktopShell('practice');
    const desktop = await freshStores();
    await expect(desktop.practice.restoreSession()).resolves.toBe(true);

    await expect(storage.get(STORAGE.app, 'practice-session:guest')).resolves.toBeUndefined();
    await expect(storage.get(STORAGE.app, 'practice-session:guest:practice')).resolves.toBeDefined();
  });
});
