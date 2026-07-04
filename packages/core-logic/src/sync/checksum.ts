/**
 * Archive checksum — implements the authoritative spec (QED2-checksum-spec.md,
 * the precise form of contract §5.4; server implements the same spec):
 *
 *  1. Only archive CONTENT participates: { perPart, perCompetency }.
 *  2. Timestamps normalized via `new Date(x).toISOString()` (ms-precision UTC).
 *  3. perPart sorted by partId, perCompetency by code (code point order).
 *  4. Optionality is field-specific: `lastResult` absent → key OMITTED;
 *     `grading` unset → null (key retained); `fsrs.lastReview` unset → null
 *     (key retained); `starred` always present.
 *  5. Floats (stability/difficulty/mastery/awardedPoints) rounded to
 *     6 decimals half-up before serialization (model/archive.ts normNum).
 *  6. Stable JSON: keys sorted by code point, no whitespace, default
 *     JSON.stringify escaping (non-ASCII stays raw UTF-8).
 *  7. checksum = lowercase hex SHA-256 of the UTF-8 bytes.
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
