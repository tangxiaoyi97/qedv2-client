/**
 * Question cache — offline-friendly passthrough store for Question JSON,
 * keyed by question id in the STORAGE.questions collection. Eviction (if ever
 * needed) can enumerate ids via StoragePort.keys().
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import type { Question } from '../model/question.js';

export class QuestionCache {
  constructor(private readonly storage: StoragePort) {}

  async get(id: string): Promise<Question | undefined> {
    return this.storage.get<Question>(STORAGE.questions, id);
  }

  async put(question: Question): Promise<void> {
    await this.storage.set(STORAGE.questions, question.id, question);
  }

  async putMany(questions: Question[]): Promise<void> {
    for (const q of questions) await this.put(q);
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }
}

/**
 * Hash a cached API question in the same canonical form as qed2-core's
 * manifest. The wire object may include runtime-only fields such as
 * `playable`, which are not part of the raw bank JSON hashed by core.
 */
export function questionContentHash(question: Question): string {
  const raw = { ...question } as Record<string, unknown>;
  delete raw.playable;
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(raw))));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}
