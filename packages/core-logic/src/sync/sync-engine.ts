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

/* ================================================================== *
 * Login-time archive choice (history-and-archive-choice upgrade §2).
 *
 * A ONE-TIME check right after login — the regular in-session syncs keep
 * following the automatic contract-§5 three-outcome flow. Only when BOTH
 * sides hold data AND their checksums differ does the user get an explicit
 * choice (merge — recommended —, keep cloud, keep local).
 * ================================================================== */

export interface ArchiveSideSummary {
  parts: number;
  competencies: number;
  /** Latest per-entry updatedAt on that side (undefined when empty). */
  lastUpdated?: string;
  /** Mean mastery over perCompetency, 0..1 (undefined when none). */
  avgMastery?: number;
}

export type LoginArchiveAssessment =
  /** Local had nothing — adopt the cloud archive outright, no dialog. */
  | { kind: 'adopt-server'; archive: LocalArchive }
  /** Cloud is empty — upload local via a normal sync (expects fast-forward). */
  | { kind: 'upload-local'; baseVersion: number }
  /** Checksums already match — just record the server version. */
  | { kind: 'in-sync'; archive: LocalArchive }
  /** Both sides hold different data — ask the user (§2.3 dialog). */
  | {
      kind: 'choice-needed';
      serverState: ServerArchiveState;
      server: ArchiveSideSummary;
      local: ArchiveSideSummary;
    };

function isEmptyContent(content: ArchiveContent): boolean {
  return content.perPart.length === 0 && content.perCompetency.length === 0;
}

export function summarizeArchiveSide(content: ArchiveContent): ArchiveSideSummary {
  const summary: ArchiveSideSummary = {
    parts: content.perPart.length,
    competencies: content.perCompetency.length,
  };
  let last = '';
  for (const p of content.perPart) if (p.updatedAt > last) last = p.updatedAt;
  for (const c of content.perCompetency) if (c.updatedAt > last) last = c.updatedAt;
  if (last !== '') summary.lastUpdated = last;
  if (content.perCompetency.length > 0) {
    summary.avgMastery =
      content.perCompetency.reduce((s, c) => s + c.mastery, 0) / content.perCompetency.length;
  }
  return summary;
}

/**
 * Pure decision step (§2.2). NOTE: the local baseVersion is meaningless when
 * logging into a (different) account, so the returned actions always anchor
 * on the server's CURRENT archiveVersion, never on the stale local one.
 */
export function assessLoginArchives(
  local: LocalArchive,
  serverState: ServerArchiveState,
): LoginArchiveAssessment {
  const serverContent: ArchiveContent = {
    perPart: serverState.perPart,
    perCompetency: serverState.perCompetency,
  };
  if (isEmptyContent(local.content)) {
    return {
      kind: 'adopt-server',
      archive: {
        content: canonicalizeArchive(serverContent),
        baseVersion: serverState.archiveVersion,
      },
    };
  }
  if (isEmptyContent(serverContent)) {
    return { kind: 'upload-local', baseVersion: serverState.archiveVersion };
  }
  if (archiveChecksum(local.content) === serverState.checksum) {
    return {
      kind: 'in-sync',
      archive: { content: local.content, baseVersion: serverState.archiveVersion },
    };
  }
  return {
    kind: 'choice-needed',
    serverState,
    server: summarizeArchiveSide(serverContent),
    local: summarizeArchiveSide(local.content),
  };
}

/**
 * "Use local" choice (§2.3): the WHOLE local archive replaces the cloud one,
 * submitted through /me/sync/resolve with the server version the user was
 * shown. A nested conflict means another device wrote meanwhile — the caller
 * should re-run the login assessment.
 */
export async function overwriteServerArchive(
  transport: SyncTransport,
  serverVersion: number,
  content: ArchiveContent,
): Promise<{ outcome: SyncOutcome; archive?: LocalArchive }> {
  const canonical = canonicalizeArchive(content);
  const res = await transport.resolve({
    baseServerVersion: serverVersion,
    resolvedArchive: canonical,
  });
  if (res.result === 'resolved') {
    return {
      outcome: { type: 'fast-forward', archiveVersion: res.archiveVersion },
      archive: { content: canonical, baseVersion: res.archiveVersion },
    };
  }
  return { outcome: { type: 'conflict', conflict: res } };
}
