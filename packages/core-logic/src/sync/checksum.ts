/**
 * Archive checksum — byte-identical port of the server's algorithm
 * (qedv2-server/src/sync/checksum.ts is the authority; contract §5.4):
 *
 *  1. Only archive CONTENT participates: { perPart, perCompetency }.
 *  2. Timestamps normalized via `new Date(x).toISOString()` (ms-precision UTC).
 *  3. perPart sorted by partId, perCompetency by code (code point order).
 *  4. Absent optionals (fsrs.lastReview, lastResult) omitted — never null.
 *  5. Stable JSON: keys sorted, undefined-valued keys dropped, no whitespace.
 *  6. checksum = lowercase hex SHA-256 of the UTF-8 bytes.
 *
 * The server uses node:crypto; core-logic must stay platform-free, so we use
 * @noble/hashes (pure TS) — output is identical.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalizeArchive } from '../model/archive.js';
import type { ArchiveContent } from '../model/archive.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}';
}

/**
 * Canonical serialization of archive content. Runs the FULL canonicalization
 * (timestamp normalization + sorting + optional-field omission) so callers
 * may pass un-normalized content; stableStringify then orders the top-level
 * keys ("perCompetency" < "perPart"), matching the server exactly.
 */
export function canonicalArchiveString(content: ArchiveContent): string {
  const canonical = canonicalizeArchive(content);
  return stableStringify({
    perPart: canonical.perPart,
    perCompetency: canonical.perCompetency,
  });
}

export function archiveChecksum(content: ArchiveContent): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalArchiveString(content))));
}

export const EMPTY_ARCHIVE_CHECKSUM: string = archiveChecksum({ perPart: [], perCompetency: [] });
