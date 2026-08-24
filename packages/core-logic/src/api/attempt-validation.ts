import type { AttemptRecord } from './types.js';

export type ValidatedQueuedAttempt = AttemptRecord & { clientAttemptId: string };

const MAX_ELAPSED_MS = 7 * 24 * 3600 * 1000;
const CONTENT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Keep this byte-for-byte equivalent to qed2-server's `isoTimestamp` shape.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Attempt has an invalid shape');
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new TypeError(`${field} must contain 1 to ${max} characters`);
  }
  return value;
}

/**
 * Parse one client outbox row using the same constraints as the Server's
 * `progress.schemas.ts` attemptSchema, with a required id for retry safety.
 * Unknown properties are intentionally stripped, matching Zod object output.
 */
export function validateQueuedAttempt(value: unknown): ValidatedQueuedAttempt {
  const attempt = objectRecord(value);
  const clientAttemptId = boundedString(attempt.clientAttemptId, 'clientAttemptId', 100);
  const questionId = boundedString(attempt.questionId, 'questionId', 200);
  const partId = boundedString(attempt.partId, 'partId', 200);

  if (typeof attempt.correct !== 'boolean') {
    throw new TypeError('correct must be a boolean');
  }
  if (typeof attempt.awardedPoints !== 'number' || !Number.isFinite(attempt.awardedPoints)) {
    throw new TypeError('awardedPoints must be finite');
  }

  const elapsedMs = attempt.elapsedMs;
  if (
    elapsedMs !== undefined
    && elapsedMs !== null
    && (typeof elapsedMs !== 'number'
      || !Number.isInteger(elapsedMs)
      || elapsedMs < 0
      || elapsedMs > MAX_ELAPSED_MS)
  ) {
    throw new TypeError(`elapsedMs must be a whole number from 0 to ${MAX_ELAPSED_MS}, null or absent`);
  }

  const gradedAt = attempt.gradedAt;
  if (
    typeof gradedAt !== 'string'
    || !ISO_TIMESTAMP.test(gradedAt)
    || !Number.isFinite(new Date(gradedAt).getTime())
  ) {
    throw new TypeError('gradedAt must be a valid ISO 8601 timestamp with an explicit timezone');
  }

  const contentSource = attempt.contentSource;
  const contentId = attempt.contentId;
  if (contentSource !== undefined && contentSource !== 'local' && contentSource !== 'remote') {
    throw new TypeError('contentSource must be local, remote or absent');
  }
  if (contentId !== undefined && (typeof contentId !== 'string' || !CONTENT_ID.test(contentId))) {
    throw new TypeError('contentId must be a 40- or 64-character lowercase hex identifier');
  }
  if ((contentSource === undefined) !== (contentId === undefined)) {
    throw new TypeError('contentSource and contentId must be present together');
  }

  return {
    clientAttemptId,
    ...(contentSource !== undefined ? { contentSource, contentId: contentId as string } : {}),
    questionId,
    partId,
    correct: attempt.correct,
    awardedPoints: attempt.awardedPoints,
    ...(elapsedMs !== undefined ? { elapsedMs: elapsedMs as number | null } : {}),
    gradedAt,
  };
}

/** Validate the Server's request envelope limits before opening the network. */
export function validateQueuedAttemptBatch(value: unknown): ValidatedQueuedAttempt[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) {
    throw new TypeError('attempts must contain 1 to 1000 rows');
  }
  return value.map(validateQueuedAttempt);
}
