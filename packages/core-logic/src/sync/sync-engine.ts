/**
 * Sync engine — client behavior for the sync protocol (contract §5, verified
 * against the real server; see docs/CONVENTIONS.md):
 *
 *  - fast-forward → adopt new baseVersion, keep local content.
 *  - merged → replace local content with the server's merge; user not notified.
 *  - conflict → surface the SyncConflict to the UI; user picks per entry, then
 *    the resolved archive is submitted via /me/sync/resolve. A resolve can
 *    conflict again (optimistic concurrency) — the caller loops.
 *
 * Transport is injected so the engine stays free of HTTP concerns and is
 * trivially testable.
 */
import { canonicalizeArchive } from '../model/archive.js';
import type { ArchiveContent, LocalArchive, ServerArchiveState } from '../model/archive.js';
import { isPartConflict } from '../api/types.js';
import type {
  ResolveRequest,
  ResolveResponse,
  SyncConflict,
  SyncRequest,
  SyncResponse,
} from '../api/types.js';
import { archiveChecksum } from './checksum.js';

export interface SyncTransport {
  getState(): Promise<ServerArchiveState>;
  sync(req: SyncRequest): Promise<SyncResponse>;
  resolve(req: ResolveRequest): Promise<ResolveResponse>;
}

export type SyncOutcome =
  | { type: 'in-sync'; archiveVersion: number }
  | { type: 'fast-forward'; archiveVersion: number }
  | { type: 'merged'; archiveVersion: number }
  | { type: 'conflict'; conflict: SyncConflict };

/**
 * Run one sync round. If checksum/version hints (e.g. from a prior GET
 * /me/state) match the local content, no network round-trip happens at all
 * (contract §8.2 step 2: equal checksums → skip sync).
 */
export async function performSync(
  transport: SyncTransport,
  local: LocalArchive,
  opts?: { serverChecksumHint?: string; serverVersionHint?: number },
): Promise<{ outcome: SyncOutcome; archive: LocalArchive }> {
  if (
    opts?.serverChecksumHint !== undefined &&
    opts.serverVersionHint !== undefined &&
    opts.serverChecksumHint === archiveChecksum(local.content)
  ) {
    return {
      outcome: { type: 'in-sync', archiveVersion: opts.serverVersionHint },
      archive: { content: local.content, baseVersion: opts.serverVersionHint },
    };
  }

  // Always send canonical content — the checksum the server computes must
  // match what we would compute locally.
  const canonical = canonicalizeArchive(local.content);
  const res = await transport.sync({ baseVersion: local.baseVersion, localArchive: canonical });

  switch (res.result) {
    case 'fast-forward':
      return {
        outcome: { type: 'fast-forward', archiveVersion: res.archiveVersion },
        archive: { content: canonical, baseVersion: res.archiveVersion },
      };
    case 'merged':
      return {
        outcome: { type: 'merged', archiveVersion: res.archiveVersion },
        archive: { content: canonicalizeArchive(res.mergedArchive), baseVersion: res.archiveVersion },
      };
    case 'conflict':
      // Local archive stays untouched until the user resolves.
      return { outcome: { type: 'conflict', conflict: res }, archive: local };
  }
}

/**
 * Assemble the resolved archive from the user's per-entry picks. `choices` is
 * keyed by partId / competencyCode; entries without a choice default to
 * 'server' — the safer, newer-cloud default the prototype dialog uses.
 */
export function buildResolvedArchive(
  conflict: SyncConflict,
  choices: Record<string, 'server' | 'local'>,
): ArchiveContent {
  const perPart = [...conflict.autoMergeable.perPart];
  const perCompetency = [...conflict.autoMergeable.perCompetency];
  for (const entry of conflict.conflicts) {
    if (isPartConflict(entry)) {
      const side = choices[entry.partId] ?? 'server';
      perPart.push(side === 'local' ? entry.local : entry.server);
    } else {
      const side = choices[entry.competencyCode] ?? 'server';
      perCompetency.push(side === 'local' ? entry.local : entry.server);
    }
  }
  return canonicalizeArchive({ perPart, perCompetency });
}

/**
 * Submit a conflict resolution. A nested conflict (someone else synced in the
 * meantime) is returned as a new 'conflict' outcome with NO archive — the
 * caller re-runs the resolution flow against the fresh conflict.
 */
export async function submitResolution(
  transport: SyncTransport,
  conflict: SyncConflict,
  resolved: ArchiveContent,
): Promise<{ outcome: SyncOutcome; archive?: LocalArchive }> {
  const res = await transport.resolve({
    baseServerVersion: conflict.serverVersion,
    resolvedArchive: resolved,
  });
  if (res.result === 'resolved') {
    return {
      outcome: { type: 'fast-forward', archiveVersion: res.archiveVersion },
      archive: { content: resolved, baseVersion: res.archiveVersion },
    };
  }
  return { outcome: { type: 'conflict', conflict: res } };
}
