import {
  STORAGE,
  hasAtomicStorage,
  type StoragePort,
} from '../ports/index.js';
import { isLocalProfileId, type LocalProfileId } from './local-profile-store.js';
import type { AiDiagnosisCode } from '../ai/types.js';

export type LearningOutcome = 'incorrect' | 'partial' | 'correct';
export type LearningHintLevel = 1 | 2 | 3;

/**
 * Local-only, deliberately minimal evidence for corrective recommendations.
 * It must never grow fields containing the learner's answer or an AI transcript.
 */
export interface LearningEvent {
  version: 1;
  partId: string;
  outcome: LearningOutcome;
  correctionOutcome?: LearningOutcome;
  hintLevel?: LearningHintLevel;
  errorCode?: AiDiagnosisCode;
  /** Exact 40-character Bank Git revision used for the attempt. */
  contentId?: string;
  /** ISO-8601 UTC of the first committed answer. */
  at: string;
}

export interface RecommendLearningEvent {
  partId: string;
  outcome: LearningOutcome;
  correctionOutcome?: LearningOutcome;
  hintLevel?: LearningHintLevel;
  errorCode?: AiDiagnosisCode;
  contentId?: string;
  at: string;
}

interface LearningEventRow {
  eventId: string;
  event: LearningEvent;
}

interface LearningEventDocument {
  version: 1;
  rows: LearningEventRow[];
}

export const LEARNING_EVENT_DOCUMENT_PREFIX = 'learning-event-document/v1/';
const MAX_CAS_ATTEMPTS = 16;
export const MAX_LEARNING_EVENTS_PER_PROFILE = 500;

export function learningEventStorageKey(profileId: LocalProfileId): string {
  if (!isLocalProfileId(profileId)) throw new TypeError('Invalid learning-event profile');
  return `${LEARNING_EVENT_DOCUMENT_PREFIX}${encodeURIComponent(profileId)}`;
}

function validateEventId(eventId: string): string {
  if (!eventId || eventId.length > 256 || eventId.includes('\0')) {
    throw new TypeError('Invalid learning-event identity');
  }
  return eventId;
}

export function parseLearningEvent(value: unknown): LearningEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Learning event is malformed');
  }
  const row = value as Partial<LearningEvent> & Record<string, unknown>;
  const allowed = new Set([
    'version',
    'partId',
    'outcome',
    'correctionOutcome',
    'hintLevel',
    'errorCode',
    'contentId',
    'at',
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error('Learning event contains non-minimal data');
  }
  if (
    row.version !== 1
    || typeof row.partId !== 'string'
    || row.partId.length === 0
    || row.partId.length > 256
    || !isOutcome(row.outcome)
    || (row.correctionOutcome !== undefined && !isOutcome(row.correctionOutcome))
    || (row.hintLevel !== undefined && row.hintLevel !== 1 && row.hintLevel !== 2 && row.hintLevel !== 3)
    || (row.errorCode !== undefined && !isDiagnosisCode(row.errorCode))
    || (row.contentId !== undefined && !/^[0-9a-f]{40}$/u.test(row.contentId))
    || typeof row.at !== 'string'
    || Number.isNaN(Date.parse(row.at))
  ) {
    throw new Error('Learning event is malformed');
  }
  return {
    version: 1,
    partId: row.partId,
    outcome: row.outcome,
    ...(row.correctionOutcome ? { correctionOutcome: row.correctionOutcome } : {}),
    ...(row.hintLevel ? { hintLevel: row.hintLevel } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.contentId ? { contentId: row.contentId } : {}),
    at: new Date(row.at).toISOString(),
  };
}

function parseDocument(value: unknown): LearningEventDocument {
  if (value === undefined) return { version: 1, rows: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Learning-event document is malformed');
  }
  const document = value as Partial<LearningEventDocument> & Record<string, unknown>;
  if (
    Object.keys(document).some((key) => key !== 'version' && key !== 'rows')
    || document.version !== 1
    || !Array.isArray(document.rows)
    || document.rows.length > MAX_LEARNING_EVENTS_PER_PROFILE
  ) {
    throw new Error('Learning-event document is malformed');
  }
  const seen = new Set<string>();
  const rows = document.rows.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Learning-event row is malformed');
    }
    const row = candidate as Partial<LearningEventRow> & Record<string, unknown>;
    if (
      Object.keys(row).some((key) => key !== 'eventId' && key !== 'event')
      || typeof row.eventId !== 'string'
    ) {
      throw new Error('Learning-event row is malformed');
    }
    const eventId = validateEventId(row.eventId);
    if (seen.has(eventId)) throw new Error('Learning-event identity is duplicated');
    seen.add(eventId);
    return { eventId, event: parseLearningEvent(row.event) };
  });
  return { version: 1, rows: sortedRows(rows) };
}

function isOutcome(value: unknown): value is LearningOutcome {
  return value === 'incorrect' || value === 'partial' || value === 'correct';
}

function isDiagnosisCode(value: unknown): value is AiDiagnosisCode {
  return value === 'concept'
    || value === 'setup'
    || value === 'algebra'
    || value === 'arithmetic'
    || value === 'condition'
    || value === 'notation-unit'
    || value === 'incomplete'
    || value === 'careless'
    || value === 'unknown';
}

function sortedRows(rows: LearningEventRow[]): LearningEventRow[] {
  return [...rows].sort((left, right) => {
    const byTime = right.event.at.localeCompare(left.event.at);
    return byTime !== 0 ? byTime : left.eventId.localeCompare(right.eventId);
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projection(event: LearningEvent): RecommendLearningEvent {
  return {
    partId: event.partId,
    outcome: event.outcome,
    ...(event.correctionOutcome ? { correctionOutcome: event.correctionOutcome } : {}),
    ...(event.hintLevel ? { hintLevel: event.hintLevel } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.contentId ? { contentId: event.contentId } : {}),
    at: event.at,
  };
}

interface MutationResult<T> {
  document: LearningEventDocument;
  value: T;
}

export class LearningEventStore {
  constructor(private readonly storage: StoragePort) {}

  private async mutate<T>(
    profileId: LocalProfileId,
    change: (current: LearningEventDocument) => MutationResult<T>,
  ): Promise<T> {
    const key = learningEventStorageKey(profileId);
    const address = { collection: STORAGE.learning, key } as const;

    const nonAtomic = async (): Promise<T> => {
      const current = parseDocument(await this.storage.get<unknown>(STORAGE.learning, key));
      const next = change(current);
      if (!sameValue(current, next.document)) {
        await this.storage.set(STORAGE.learning, key, next.document);
      }
      return next.value;
    };
    if (!hasAtomicStorage(this.storage)) {
      return this.storage.runExclusiveMutation
        ? this.storage.runExclusiveMutation(nonAtomic)
        : nonAtomic();
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const [snapshot] = await this.storage.readBatch([address]);
      if (!snapshot) throw new Error('Learning-event read returned no entry');
      const current = parseDocument(snapshot.exists ? snapshot.value : undefined);
      const next = change(current);
      if (sameValue(current, next.document)) return next.value;
      try {
        const committed = await this.storage.commitBatch({
          ifRevisions: [{ ...address, revision: snapshot.revision }],
          mutations: [{ ...address, operation: 'set', value: next.document }],
        });
        if (committed.committed) return next.value;
      } catch (cause) {
        // A rejected commit has an unknown outcome. Reapplying the pure
        // mutation to the durable document proves whether it already landed.
        const durable = parseDocument(
          await this.storage.get<unknown>(STORAGE.learning, key).catch(() => undefined),
        );
        const confirmation = change(durable);
        if (sameValue(durable, confirmation.document)) return confirmation.value;
        throw cause;
      }
    }
    throw new Error('Learning events changed too often');
  }

  async recordFirst(
    profileId: LocalProfileId,
    eventId: string,
    event: LearningEvent,
  ): Promise<void> {
    validateEventId(eventId);
    const expected = parseLearningEvent(event);
    await this.mutate(profileId, (current) => {
      const existing = current.rows.find((row) => row.eventId === eventId);
      if (existing) {
        if (!sameValue(existing.event, expected)) {
          throw new Error('Learning-event identity was reused');
        }
        return { document: current, value: undefined };
      }
      // A single CAS-protected document makes 500 a hard bound across browser
      // tabs and Desktop windows. Timestamp plus event id is the deterministic
      // tie-break, so concurrent writers always converge on the same set.
      const rows = sortedRows([...current.rows, { eventId, event: expected }])
        .slice(0, MAX_LEARNING_EVENTS_PER_PROFILE);
      return { document: { version: 1, rows }, value: undefined };
    });
  }

  async recordCorrection(
    profileId: LocalProfileId,
    eventId: string,
    correctionOutcome: LearningOutcome,
  ): Promise<LearningEvent> {
    validateEventId(eventId);
    if (!isOutcome(correctionOutcome)) throw new TypeError('Invalid correction outcome');
    return this.mutate(profileId, (current) => {
      const index = current.rows.findIndex((row) => row.eventId === eventId);
      if (index < 0) throw new Error('First attempt learning event is missing');
      const previous = current.rows[index]!.event;
      if (previous.correctionOutcome && previous.correctionOutcome !== correctionOutcome) {
        throw new Error('A correction outcome is already recorded');
      }
      if (previous.correctionOutcome === correctionOutcome) {
        return { document: current, value: previous };
      }
      const event = { ...previous, correctionOutcome };
      const rows = current.rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, event } : row);
      return { document: { version: 1, rows }, value: event };
    });
  }

  async recordDiagnosis(
    profileId: LocalProfileId,
    eventId: string,
    errorCode: AiDiagnosisCode,
  ): Promise<LearningEvent> {
    validateEventId(eventId);
    if (!isDiagnosisCode(errorCode)) throw new TypeError('Invalid diagnosis code');
    return this.mutate(profileId, (current) => {
      const index = current.rows.findIndex((row) => row.eventId === eventId);
      if (index < 0) throw new Error('First attempt learning event is missing');
      const previous = current.rows[index]!.event;
      if (previous.errorCode && previous.errorCode !== errorCode) {
        throw new Error('A diagnosis is already recorded');
      }
      if (previous.errorCode === errorCode) {
        return { document: current, value: previous };
      }
      const event = { ...previous, errorCode };
      const rows = current.rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, event } : row);
      return { document: { version: 1, rows }, value: event };
    });
  }

  /** Exact-attempt lookup used to close a crash window while restoring practice. */
  async event(profileId: LocalProfileId, eventId: string): Promise<LearningEvent | undefined> {
    validateEventId(eventId);
    const document = parseDocument(await this.storage.get<unknown>(
      STORAGE.learning,
      learningEventStorageKey(profileId),
    ));
    return document.rows.find((row) => row.eventId === eventId)?.event;
  }

  /** Newest event per part; bounded before it crosses the Core boundary. */
  async recommendEvents(profileId: LocalProfileId, limit = 100): Promise<RecommendLearningEvent[]> {
    const document = parseDocument(await this.storage.get<unknown>(
      STORAGE.learning,
      learningEventStorageKey(profileId),
    ));
    const seen = new Set<string>();
    const out: RecommendLearningEvent[] = [];
    for (const row of document.rows) {
      if (seen.has(row.event.partId)) continue;
      seen.add(row.event.partId);
      out.push(projection(row.event));
      if (out.length >= Math.max(0, Math.min(limit, 100))) break;
    }
    return out;
  }
}
