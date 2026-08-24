/** Opaque local-cache keys: request material must never appear in IndexedDB keys. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { stableStringify } from '../sync/checksum.js';

export function aiCacheDigest(value: unknown): string {
  return `v2:${bytesToHex(sha256(utf8ToBytes(stableStringify(value))))}`;
}

/** A non-derivable UUID for paid request ids; fails closed without Web Crypto. */
export function secureRandomUuidV4(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error('Secure random UUID generation is unavailable');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable UUIDv4-shaped identity for non-secret local objects.
 *
 * Never use this for a paid provider request: low-entropy answers could be
 * guessed from a persisted deterministic id. Paid ids use secureRandomUuidV4
 * and persist the random winner in their local CAS journal instead.
 */
export function deterministicAiRequestId(value: unknown): string {
  const bytes = sha256(utf8ToBytes(stableStringify(value))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
