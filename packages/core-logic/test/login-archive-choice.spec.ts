import { describe, expect, it } from 'vitest';
import {
  assessLoginArchives,
  overwriteServerArchive,
  summarizeArchiveSide,
} from '../src/sync/sync-engine.js';
import { archiveChecksum } from '../src/sync/checksum.js';
import type { ArchiveContent, LocalArchive, PartEntry, ServerArchiveState } from '../src/model/archive.js';
import type { ResolveRequest, ResolveResponse } from '../src/api/types.js';

const part = (partId: string, updatedAt: string): PartEntry => ({
  partId,
  grading: 'good',
  starred: false,
  fsrs: { due: '2026-07-10T00:00:00.000Z', stability: 2, difficulty: 5, reps: 1, lapses: 0, lastReview: null },
  updatedAt,
});

const localContent: ArchiveContent = {
  perPart: [part('p-local', '2026-07-02T00:00:00.000Z')],
  perCompetency: [{ code: 'AG 1.1', mastery: 0.5, updatedAt: '2026-07-02T00:00:00.000Z' }],
};

const serverContent: ArchiveContent = {
  perPart: [part('p-cloud', '2026-07-03T00:00:00.000Z')],
  perCompetency: [{ code: 'FA 1.5', mastery: 0.8, updatedAt: '2026-07-03T00:00:00.000Z' }],
};

function serverState(content: ArchiveContent, version = 7): ServerArchiveState {
  return {
    archiveVersion: version,
    checksum: archiveChecksum(content),
    updatedAt: '2026-07-03T00:00:00.000Z',
    perPart: content.perPart,
    perCompetency: content.perCompetency,
  };
}

const emptyLocal: LocalArchive = { content: { perPart: [], perCompetency: [] }, baseVersion: 0 };

describe('assessLoginArchives (upgrade doc §2.2)', () => {
  it('local empty → adopt-server with the server version as baseVersion', () => {
    const a = assessLoginArchives(emptyLocal, serverState(serverContent));
    expect(a.kind).toBe('adopt-server');
    if (a.kind !== 'adopt-server') throw new Error('unreachable');
    expect(a.archive.baseVersion).toBe(7);
    expect(a.archive.content.perPart[0]!.partId).toBe('p-cloud');
  });

  it('both empty → adopt-server (silent, equivalent to in-sync)', () => {
    const a = assessLoginArchives(emptyLocal, serverState({ perPart: [], perCompetency: [] }, 0));
    expect(a.kind).toBe('adopt-server');
  });

  it('server empty → upload-local anchored on the SERVER version (stale local baseVersion ignored)', () => {
    const local: LocalArchive = { content: localContent, baseVersion: 99 };
    const a = assessLoginArchives(local, serverState({ perPart: [], perCompetency: [] }, 3));
    expect(a).toEqual({ kind: 'upload-local', baseVersion: 3 });
  });

  it('identical checksums → in-sync, baseVersion updated', () => {
    const local: LocalArchive = { content: localContent, baseVersion: 1 };
    const a = assessLoginArchives(local, serverState(localContent, 12));
    expect(a.kind).toBe('in-sync');
    if (a.kind !== 'in-sync') throw new Error('unreachable');
    expect(a.archive.baseVersion).toBe(12);
    expect(a.archive.content).toBe(local.content);
  });

  it('both non-empty and different → choice-needed with side summaries', () => {
    const local: LocalArchive = { content: localContent, baseVersion: 1 };
    const a = assessLoginArchives(local, serverState(serverContent));
    expect(a.kind).toBe('choice-needed');
    if (a.kind !== 'choice-needed') throw new Error('unreachable');
    expect(a.server.parts).toBe(1);
    expect(a.local.parts).toBe(1);
    expect(a.server.lastUpdated).toBe('2026-07-03T00:00:00.000Z');
    expect(a.local.avgMastery).toBeCloseTo(0.5, 10);
  });
});

describe('summarizeArchiveSide', () => {
  it('summarizes counts, latest stamp and mean mastery; omits fields when empty', () => {
    const s = summarizeArchiveSide(serverContent);
    expect(s).toEqual({
      parts: 1,
      competencies: 1,
      lastUpdated: '2026-07-03T00:00:00.000Z',
      avgMastery: 0.8,
    });
    expect(summarizeArchiveSide({ perPart: [], perCompetency: [] })).toEqual({
      parts: 0,
      competencies: 0,
    });
  });
});

describe('overwriteServerArchive ("use local" choice, §2.3)', () => {
  function transportWith(resolve: (req: ResolveRequest) => ResolveResponse) {
    const calls: ResolveRequest[] = [];
    return {
      calls,
      transport: {
        getState: () => Promise.reject(new Error('unused')),
        sync: () => Promise.reject(new Error('unused')),
        resolve: (req: ResolveRequest) => {
          calls.push(req);
          return Promise.resolve(resolve(req));
        },
      },
    };
  }

  it('submits the canonicalized local content against the shown server version', async () => {
    const { calls, transport } = transportWith(() => ({
      result: 'resolved',
      archiveVersion: 8,
      checksum: 'x',
    }));
    const res = await overwriteServerArchive(transport, 7, localContent);
    expect(calls[0]!.baseServerVersion).toBe(7);
    expect(calls[0]!.resolvedArchive.perPart[0]!.partId).toBe('p-local');
    expect(res.outcome).toEqual({ type: 'fast-forward', archiveVersion: 8 });
    expect(res.archive?.baseVersion).toBe(8);
  });

  it('surfaces a nested conflict (another device raced) without an archive', async () => {
    const { transport } = transportWith(() => ({
      result: 'conflict',
      serverVersion: 9,
      serverChecksum: 'y',
      conflicts: [],
      autoMergeable: { perPart: [], perCompetency: [] },
    }));
    const res = await overwriteServerArchive(transport, 7, localContent);
    expect(res.outcome.type).toBe('conflict');
    expect(res.archive).toBeUndefined();
  });
});
