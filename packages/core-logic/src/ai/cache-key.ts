/** Opaque local-cache keys: request material must never appear in IndexedDB keys. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { stableStringify } from '../sync/checksum.js';

export function aiCacheDigest(value: unknown): string {
  return `v2:${bytesToHex(sha256(utf8ToBytes(stableStringify(value))))}`;
}
