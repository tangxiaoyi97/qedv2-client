/**
 * Live end-to-end acceptance run against the REAL local services
 * (webclient brief §9): non-empty-archive checksum parity with the server,
 * and the full sync protocol — fast-forward, merged, conflict + resolve.
 *
 * Gated behind env credentials so CI/dev machines without the services or an
 * account skip it cleanly:
 *
 *   QED2_E2E_SERVER=http://localhost:8080 \
 *   QED2_E2E_USER=... QED2_E2E_PASS=... pnpm exec vitest run test/e2e-live.spec.ts
 *
 * NOTE: mutates the account's server archive. Use a dedicated test account.
 */
import { describe, expect, it } from 'vitest';
import { ServerClient } from '../src/api/server-client.js';
import { archiveChecksum } from '../src/sync/checksum.js';
import { buildResolvedArchive, performSync, submitResolution } from '../src/sync/sync-engine.js';
import type { ArchiveContent, PartEntry } from '../src/model/archive.js';

const SERVER = process.env['QED2_E2E_SERVER'] ?? 'http://localhost:8080';
const USER = process.env['QED2_E2E_USER'];
const PASS = process.env['QED2_E2E_PASS'];

const enabled = Boolean(USER && PASS);

function part(partId: string, opts: { stamp: string; due?: string; points?: number; stability?: number }): PartEntry {
  return {
    partId,
    fsrs: {
      due: opts.due ?? '2026-08-01T00:00:00.000Z',
      stability: opts.stability ?? 2.5,
      difficulty: 5.2,
      reps: 1,
      lapses: 0,
      lastReview: opts.stamp,
    },
    lastResult: { correct: true, awardedPoints: opts.points ?? 1, gradedAt: opts.stamp },
    updatedAt: opts.stamp,
  };
}

describe.skipIf(!enabled)('live sync acceptance (real qed2-server)', () => {
  it('covers checksum parity and all three sync outcomes', async () => {
    let token: string | undefined;
    const client = new ServerClient(SERVER, () => token);
    const login = await client.login(USER!, PASS!);
    token = login.token;

    // unique per run so repeated runs never collide with stale state
    const runId = `e2e-${Date.now()}`;
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date(Date.now() - 30_000).toISOString();

    /* -------- baseline: adopt whatever the account currently has -------- */
    const before = await client.getState();

    /* -------- case 1: fast-forward + non-empty checksum parity -------- */
    const contentA: ArchiveContent = {
      perPart: [part(`${runId}-p1`, { stamp: t1 }), part(`${runId}-p2`, { stamp: t1, points: 0.5 })],
      perCompetency: [
        { code: 'AG 1.1', mastery: 0.42, updatedAt: t1 },
        { code: 'FA 1.5', mastery: 0.77, updatedAt: t1 },
      ],
    };
    const r1 = await performSync(client, { content: contentA, baseVersion: before.archiveVersion });
    expect(r1.outcome.type).toBe('fast-forward');
    const v1 = (r1.outcome as { archiveVersion: number }).archiveVersion;
    expect(v1).toBe(before.archiveVersion + 1);

    // byte-identical checksum on a NON-EMPTY archive (acceptance anchor)
    const state1 = await client.getState();
    expect(archiveChecksum(r1.archive.content)).toBe(state1.checksum);

    /* -------- case 2: merged (stale baseVersion, disjoint part) -------- */
    // second "device" never saw v1: baseVersion = before.archiveVersion
    const contentB: ArchiveContent = {
      perPart: [part(`${runId}-p3`, { stamp: t2 })],
      perCompetency: [{ code: 'AN 3.3', mastery: 0.2, updatedAt: t2 }],
    };
    const r2 = await performSync(client, { content: contentB, baseVersion: before.archiveVersion });
    expect(r2.outcome.type).toBe('merged');
    const mergedIds = r2.archive.content.perPart.map((p) => p.partId);
    expect(mergedIds).toEqual(expect.arrayContaining([`${runId}-p1`, `${runId}-p2`, `${runId}-p3`]));
    const state2 = await client.getState();
    expect(archiveChecksum(r2.archive.content)).toBe(state2.checksum);

    /* -------- case 3: true conflict (same part, same stamp, different data) + resolve -------- */
    const conflicting: ArchiveContent = {
      perPart: [
        // identical updatedAt (t1) as the server's copy of p1 but different points
        { ...part(`${runId}-p1`, { stamp: t1, points: 0 }), lastResult: { correct: false, awardedPoints: 0, gradedAt: t1 } },
      ],
      perCompetency: [],
    };
    const r3 = await performSync(client, { content: conflicting, baseVersion: before.archiveVersion });
    expect(r3.outcome.type).toBe('conflict');
    if (r3.outcome.type !== 'conflict') throw new Error('unreachable');
    const conflict = r3.outcome.conflict;
    expect(conflict.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflict.serverVersion).toBe(state2.archiveVersion);

    // resolve: keep the local (losing) side for p1 → server must adopt it
    const resolved = buildResolvedArchive(conflict, { [`${runId}-p1`]: 'local' });
    const r4 = await submitResolution(client, conflict, resolved);
    expect(r4.outcome.type).toBe('fast-forward');

    const state3 = await client.getState();
    expect(archiveChecksum(resolved)).toBe(state3.checksum);
    const p1Final = state3.perPart.find((p) => p.partId === `${runId}-p1`);
    expect(p1Final?.lastResult?.correct).toBe(false); // the picked local side won
  }, 30_000);
});
