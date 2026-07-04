import { describe, expect, it } from 'vitest';
import {
  archiveChecksum,
  buildResolvedArchive,
  performSync,
  submitResolution,
} from '../src/sync/index.js';
import type { SyncTransport } from '../src/sync/index.js';
import { canonicalizeArchive } from '../src/model/archive.js';
import type { ArchiveContent, LocalArchive, ServerArchiveState } from '../src/model/archive.js';
import type {
  ResolveRequest,
  ResolveResponse,
  SyncConflict,
  SyncRequest,
  SyncResponse,
} from '../src/api/types.js';

const part = (partId: string, updatedAt: string, stability = 1): ArchiveContent['perPart'][number] => ({
  partId,
  grading: null,
  starred: false,
  fsrs: { due: '2026-07-10T00:00:00.000Z', stability, difficulty: 5, reps: 1, lapses: 0, lastReview: null },
  updatedAt,
});

const comp = (code: string, mastery: number, updatedAt: string): ArchiveContent['perCompetency'][number] => ({
  code,
  mastery,
  updatedAt,
});

const localContent: ArchiveContent = {
  perPart: [part('p-b', '2026-07-01T00:00:00.000Z'), part('p-a', '2026-07-02T00:00:00.000Z')],
  perCompetency: [comp('FA 1.5', 0.4, '2026-07-01T00:00:00.000Z')],
};

const localArchive: LocalArchive = { content: localContent, baseVersion: 3 };

interface FakeCalls {
  sync: SyncRequest[];
  resolve: ResolveRequest[];
}

function fakeTransport(handlers: {
  sync?: (req: SyncRequest) => SyncResponse;
  resolve?: (req: ResolveRequest) => ResolveResponse;
}): { transport: SyncTransport; calls: FakeCalls } {
  const calls: FakeCalls = { sync: [], resolve: [] };
  const transport: SyncTransport = {
    getState(): Promise<ServerArchiveState> {
      throw new Error('getState not expected in this test');
    },
    async sync(req) {
      calls.sync.push(req);
      if (!handlers.sync) throw new Error('sync not expected');
      return handlers.sync(req);
    },
    async resolve(req) {
      calls.resolve.push(req);
      if (!handlers.resolve) throw new Error('resolve not expected');
      return handlers.resolve(req);
    },
  };
  return { transport, calls };
}

describe('performSync', () => {
  it('short-circuits to in-sync without network when hints match', async () => {
    const { transport, calls } = fakeTransport({});
    const hint = archiveChecksum(localArchive.content);
    const { outcome, archive } = await performSync(transport, localArchive, {
      serverChecksumHint: hint,
      serverVersionHint: 7,
    });
    expect(outcome).toEqual({ type: 'in-sync', archiveVersion: 7 });
    expect(archive.baseVersion).toBe(7);
    expect(archive.content).toBe(localArchive.content);
    expect(calls.sync).toHaveLength(0);
  });

  it('syncs over the network when the hint checksum differs', async () => {
    const { transport, calls } = fakeTransport({
      sync: () => ({ result: 'fast-forward', archiveVersion: 4, checksum: 'x' }),
    });
    const { outcome } = await performSync(transport, localArchive, {
      serverChecksumHint: 'not-the-local-checksum',
      serverVersionHint: 9,
    });
    expect(outcome.type).toBe('fast-forward');
    expect(calls.sync).toHaveLength(1);
  });

  it('fast-forward keeps (canonicalized) local content and adopts the new version', async () => {
    const { transport, calls } = fakeTransport({
      sync: () => ({ result: 'fast-forward', archiveVersion: 4, checksum: 'x' }),
    });
    const { outcome, archive } = await performSync(transport, localArchive);
    expect(outcome).toEqual({ type: 'fast-forward', archiveVersion: 4 });
    expect(archive.baseVersion).toBe(4);
    expect(archive.content).toEqual(canonicalizeArchive(localContent));
    // The request carried the base version and canonical content.
    expect(calls.sync[0]!.baseVersion).toBe(3);
    expect(calls.sync[0]!.localArchive.perPart.map((p) => p.partId)).toEqual(['p-a', 'p-b']);
  });

  it('merged replaces local content with the server merge', async () => {
    const merged: ArchiveContent = {
      perPart: [part('p-a', '2026-07-02T00:00:00.000Z'), part('p-c', '2026-07-03T00:00:00.000Z')],
      perCompetency: [comp('FA 1.5', 0.6, '2026-07-03T00:00:00.000Z')],
    };
    const { transport } = fakeTransport({
      sync: () => ({ result: 'merged', archiveVersion: 5, checksum: 'y', mergedArchive: merged }),
    });
    const { outcome, archive } = await performSync(transport, localArchive);
    expect(outcome).toEqual({ type: 'merged', archiveVersion: 5 });
    expect(archive.baseVersion).toBe(5);
    expect(archive.content).toEqual(canonicalizeArchive(merged));
  });

  it('conflict passes the SyncConflict through untouched and leaves the archive unchanged', async () => {
    const conflict: SyncConflict = {
      result: 'conflict',
      serverVersion: 6,
      serverChecksum: 'z',
      conflicts: [
        {
          partId: 'p-a',
          server: part('p-a', '2026-07-03T00:00:00.000Z', 2),
          local: part('p-a', '2026-07-02T00:00:00.000Z', 1),
        },
      ],
      autoMergeable: { perPart: [part('p-b', '2026-07-01T00:00:00.000Z')], perCompetency: [] },
    };
    const { transport } = fakeTransport({ sync: () => conflict });
    const { outcome, archive } = await performSync(transport, localArchive);
    expect(outcome.type).toBe('conflict');
    if (outcome.type === 'conflict') expect(outcome.conflict).toBe(conflict);
    expect(archive).toBe(localArchive);
    expect(archive.baseVersion).toBe(3);
  });
});

describe('buildResolvedArchive', () => {
  const serverPart = part('p-a', '2026-07-03T00:00:00.000Z', 2);
  const localPart = part('p-a', '2026-07-02T00:00:00.000Z', 1);
  const serverComp = comp('AN 4.3', 0.9, '2026-07-03T00:00:00.000Z');
  const localComp = comp('AN 4.3', 0.2, '2026-07-02T00:00:00.000Z');

  const conflict: SyncConflict = {
    result: 'conflict',
    serverVersion: 6,
    serverChecksum: 'z',
    // Mixed entry list, exactly as the server emits it.
    conflicts: [
      { partId: 'p-a', server: serverPart, local: localPart },
      { competencyCode: 'AN 4.3', server: serverComp, local: localComp },
    ],
    autoMergeable: {
      perPart: [part('p-b', '2026-07-01T00:00:00.000Z')],
      perCompetency: [comp('FA 1.5', 0.4, '2026-07-01T00:00:00.000Z')],
    },
  };

  it('applies per-entry choices on top of autoMergeable', () => {
    const resolved = buildResolvedArchive(conflict, { 'p-a': 'local', 'AN 4.3': 'server' });
    expect(resolved.perPart.map((p) => p.partId)).toEqual(['p-a', 'p-b']);
    expect(resolved.perPart.find((p) => p.partId === 'p-a')!.fsrs.stability).toBe(1); // local
    expect(resolved.perCompetency.find((c) => c.code === 'AN 4.3')!.mastery).toBe(0.9); // server
    expect(resolved.perCompetency.map((c) => c.code)).toEqual(['AN 4.3', 'FA 1.5']); // sorted
  });

  it('defaults missing choices to the server side', () => {
    const resolved = buildResolvedArchive(conflict, {});
    expect(resolved.perPart.find((p) => p.partId === 'p-a')!.fsrs.stability).toBe(2); // server
    expect(resolved.perCompetency.find((c) => c.code === 'AN 4.3')!.mastery).toBe(0.9); // server
  });

  it('does not mutate the conflict payload and returns canonical content', () => {
    const before = JSON.stringify(conflict);
    const resolved = buildResolvedArchive(conflict, { 'p-a': 'local' });
    expect(JSON.stringify(conflict)).toBe(before);
    // Canonical: sorted by partId/code.
    expect([...resolved.perPart.map((p) => p.partId)].sort()).toEqual(
      resolved.perPart.map((p) => p.partId),
    );
  });
});

describe('submitResolution', () => {
  const conflict: SyncConflict = {
    result: 'conflict',
    serverVersion: 6,
    serverChecksum: 'z',
    conflicts: [],
    autoMergeable: { perPart: [], perCompetency: [] },
  };
  const resolved: ArchiveContent = {
    perPart: [part('p-a', '2026-07-02T00:00:00.000Z')],
    perCompetency: [],
  };

  it('resolved → fast-forward outcome with new local archive', async () => {
    const { transport, calls } = fakeTransport({
      resolve: () => ({ result: 'resolved', archiveVersion: 7, checksum: 'w' }),
    });
    const { outcome, archive } = await submitResolution(transport, conflict, resolved);
    expect(outcome).toEqual({ type: 'fast-forward', archiveVersion: 7 });
    expect(archive).toEqual({ content: resolved, baseVersion: 7 });
    expect(calls.resolve[0]).toEqual({ baseServerVersion: 6, resolvedArchive: resolved });
  });

  it('nested conflict → conflict outcome without an archive (caller loops)', async () => {
    const nested: SyncConflict = {
      result: 'conflict',
      serverVersion: 8,
      serverChecksum: 'v',
      conflicts: [],
      autoMergeable: { perPart: [], perCompetency: [] },
    };
    const { transport } = fakeTransport({ resolve: () => nested });
    const first = await submitResolution(transport, conflict, resolved);
    expect(first.outcome.type).toBe('conflict');
    expect(first.archive).toBeUndefined();
    expect('archive' in first).toBe(false); // key omitted, not undefined-assigned

    // Caller loop: resolve again against the NEW conflict's serverVersion.
    const { transport: t2, calls: c2 } = fakeTransport({
      resolve: () => ({ result: 'resolved', archiveVersion: 9, checksum: 'u' }),
    });
    if (first.outcome.type !== 'conflict') throw new Error('unreachable');
    const second = await submitResolution(t2, first.outcome.conflict, resolved);
    expect(c2.resolve[0]!.baseServerVersion).toBe(8);
    expect(second.outcome).toEqual({ type: 'fast-forward', archiveVersion: 9 });
    expect(second.archive?.baseVersion).toBe(9);
  });
});
