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

  private scopedKey(id: string, contentId?: string): string {
    const scope = contentId
      ? bytesToHex(sha256(utf8ToBytes(contentId)))
      : undefined;
    return scope ? `bank:${scope}:${id}` : id;
  }

  async get(id: string, contentId?: string): Promise<Question | undefined> {
    const cached = await this.storage.get<unknown>(
      STORAGE.questions,
      this.scopedKey(id, contentId),
    );
    if (isVerifiedEnvelope(cached)) return cached.question;
    return cached !== null && typeof cached === 'object' ? cached as Question : undefined;
  }

  async put(question: Question, contentId?: string): Promise<void> {
    await this.storage.set(STORAGE.questions, this.scopedKey(question.id, contentId), question);
  }

  async putMany(questions: Question[], contentId?: string): Promise<void> {
    for (const q of questions) await this.put(q, contentId);
  }

  /**
   * Persist proof that a scoped entry was admitted against Core's authoritative
   * raw-JSON hash. Question and proof share one storage envelope, so a crash
   * cannot expose a new payload under stale verification metadata.
   */
  async putVerified(
    question: Question,
    contentId: string,
    contentHash: string,
    wireHash: string,
  ): Promise<void> {
    await this.storage.set(STORAGE.questions, this.scopedKey(question.id, contentId), {
      kind: 'qed2-verified-question',
      verificationSchemaVersion: 1,
      contentId,
      contentHash,
      wireHash,
      questionSchemaVersion: question.schemaVersion,
      question,
    } satisfies VerifiedQuestionEnvelope);
  }

  async putManyVerified(
    questions: Array<{ question: Question; contentHash: string; wireHash: string }>,
    contentId: string,
  ): Promise<void> {
    for (const entry of questions) {
      await this.putVerified(entry.question, contentId, entry.contentHash, entry.wireHash);
    }
  }

  /** Only revision+hash-proven entries may be used without a live manifest. */
  async getVerified(
    id: string,
    contentId: string,
    expectedContentHash?: string,
  ): Promise<Question | undefined> {
    const cached = await this.storage.get<unknown>(
      STORAGE.questions,
      this.scopedKey(id, contentId),
    );
    if (!isVerifiedEnvelope(cached) || cached.contentId !== contentId) return undefined;
    if (cached.question.id !== id || cached.question.schemaVersion !== cached.questionSchemaVersion) {
      return undefined;
    }
    if (!isSha256(cached.contentHash)) return undefined;
    if (expectedContentHash !== undefined && cached.contentHash !== expectedContentHash) return undefined;
    if (!isSha256(cached.wireHash)) return undefined;
    if (questionContentHash(cached.question) !== cached.wireHash) return undefined;
    return cached.question;
  }

  async has(id: string, contentId?: string): Promise<boolean> {
    return (await this.get(id, contentId)) !== undefined;
  }

}

interface VerifiedQuestionEnvelope {
  kind: 'qed2-verified-question';
  verificationSchemaVersion: 1;
  contentId: string;
  contentHash: string;
  wireHash: string;
  questionSchemaVersion: number;
  question: Question;
}

function isVerifiedEnvelope(
  value: unknown,
): value is VerifiedQuestionEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.kind === 'qed2-verified-question'
    && candidate.verificationSchemaVersion === 1
    && typeof candidate.contentId === 'string'
    && typeof candidate.contentHash === 'string'
    && typeof candidate.wireHash === 'string'
    && typeof candidate.questionSchemaVersion === 'number'
    && candidate.question !== null
    && typeof candidate.question === 'object';
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Hash the normalized Question payload in the same canonical form as Core's
 * `wireHash`. This is deliberately NOT the manifest/raw-bank contentHash:
 * schema defaults can make the parsed wire object differ from its source JSON.
 */
export function questionContentHash(question: Question): string {
  const raw = { ...question } as Record<string, unknown>;
  // Defensive only: CoreClient strips security metadata before returning the
  // Question, but callers may pass a structural subtype at runtime.
  delete raw.contentHash;
  delete raw.wireHash;
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
